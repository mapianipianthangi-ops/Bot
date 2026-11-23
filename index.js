'use strict';
/* ==========================================================================
   WANDS OF FATE
   Stage 1: core framework, database + migrations, server config,
            unified slash/prefix command layer, moderation system.
   Stage 2: magical content library, discovery, collections, codex.
   Sections:  1 Setup   2 Database   3 Helpers   4 Command layer
              5 Moderation   6 Config   7 Info   8 Events
   ========================================================================== */

/* ------------------------------ 1. SETUP --------------------------------- */
const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch { /* dotenv is optional in production */ }

const {
  Client, GatewayIntentBits, PermissionFlagsBits: P, EmbedBuilder, SlashCommandBuilder,
  REST, Routes, MessageFlags, Events, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
} = require('discord.js');
const Database = require('better-sqlite3');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('DISCORD_TOKEN is not set.'); process.exit(1); }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
});

/* ----------------------------- 2. DATABASE ------------------------------- */
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'wandsoffate.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Each entry runs once, in order. Later stages append new entries; never edit old ones.
const MIGRATIONS = [
  `CREATE TABLE guild_config (
     guild_id TEXT PRIMARY KEY,
     prefix TEXT NOT NULL DEFAULT '!',
     mod_log_channel TEXT,
     color TEXT NOT NULL DEFAULT '#2b2540'
   );
   CREATE TABLE cases (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     num INTEGER NOT NULL,
     type TEXT NOT NULL,
     user_id TEXT NOT NULL,
     mod_id TEXT NOT NULL,
     reason TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER,
     active INTEGER NOT NULL DEFAULT 1,
     UNIQUE (guild_id, num)
   );
   CREATE INDEX idx_cases_user ON cases (guild_id, user_id, type, active);
   CREATE INDEX idx_cases_expiry ON cases (active, expires_at);`,
  // Stage 2: discovery system
  `CREATE TABLE collection (
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     item_id TEXT NOT NULL,
     cat TEXT NOT NULL,
     name TEXT NOT NULL,
     rarity TEXT NOT NULL,
     qty INTEGER NOT NULL DEFAULT 1,
     first_at INTEGER NOT NULL,
     last_at INTEGER NOT NULL,
     PRIMARY KEY (guild_id, user_id, item_id)
   );
   CREATE INDEX idx_collection_user ON collection (guild_id, user_id, cat);
   CREATE TABLE discovery_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     item_id TEXT NOT NULL,
     name TEXT NOT NULL,
     cat TEXT NOT NULL,
     rarity TEXT NOT NULL,
     at INTEGER NOT NULL,
     duplicate INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX idx_history_user ON discovery_history (guild_id, user_id, at);`,
];
{
  const current = db.pragma('user_version', { simple: true });
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => { db.exec(MIGRATIONS[i]); db.pragma(`user_version = ${i + 1}`); })();
  }
}

const CONFIG_KEYS = new Set(['prefix', 'mod_log_channel', 'color']);
function getConfig(guildId) {
  let row = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
  if (!row) {
    db.prepare('INSERT INTO guild_config (guild_id) VALUES (?)').run(guildId);
    row = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
  }
  return row;
}
function setConfig(guildId, key, value) {
  if (!CONFIG_KEYS.has(key)) throw new Error(`Unknown config key ${key}`);
  getConfig(guildId);
  db.prepare(`UPDATE guild_config SET ${key} = ? WHERE guild_id = ?`).run(value, guildId);
}

/* ------------------------------ 3. HELPERS ------------------------------- */
class UserError extends Error {}

const TYPE_LABEL = {
  warn: 'Warning', unwarn: 'Warning removed', mute: 'Timeout', unmute: 'Timeout removed',
  kick: 'Kick', ban: 'Ban', unban: 'Unban', softban: 'Softban', tempban: 'Temporary ban',
};
const TYPE_COLOR = {
  warn: 0xc9a227, unwarn: 0x4a7c59, mute: 0xd9822b, unmute: 0x4a7c59, kick: 0xd9822b,
  ban: 0x8b2f3a, unban: 0x4a7c59, softban: 0x8b2f3a, tempban: 0x8b2f3a,
};
const FOOTER = 'Wands of Fate';

function embed(cfg, description) {
  const e = new EmbedBuilder().setColor(cfg && /^#[0-9a-f]{6}$/i.test(cfg.color) ? cfg.color : '#2b2540').setFooter({ text: FOOTER });
  if (description) e.setDescription(description);
  return e;
}
const failEmbed = (text) => new EmbedBuilder().setColor(0x8b2f3a).setDescription(text).setFooter({ text: FOOTER });

const UNITS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
function parseDuration(input) {
  const s = String(input).trim();
  if (!/^(\d+\s*[smhdw]\s*)+$/i.test(s)) return null;
  const re = /(\d+)\s*([smhdw])/gi;
  let total = 0, m;
  while ((m = re.exec(s))) total += Number(m[1]) * UNITS[m[2].toLowerCase()];
  return total > 0 ? total : null;
}
function fmtDuration(ms) {
  const parts = [];
  for (const [label, size] of [['d', 864e5], ['h', 36e5], ['m', 6e4], ['s', 1e3]]) {
    const n = Math.floor(ms / size);
    if (n) { parts.push(n + label); ms -= n * size; }
  }
  return parts.join(' ') || '0s';
}
const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const DEFAULT_REASON = 'No reason provided';

/* --------------------------- 4. COMMAND LAYER ---------------------------- */
// Every command is defined once and exposed as both a slash command and a prefix command.
const opt = (type, name, description, required = false, extra = {}) => ({ type, name, description, required, ...extra });
const commands = [];
const lookup = new Map(); // name or alias -> command
function define(cmd) {
  commands.push(cmd);
  lookup.set(cmd.name, cmd);
  for (const a of cmd.aliases || []) lookup.set(a, cmd);
}

class Ctx {
  constructor({ interaction, message, cmd, sub, cfg }) {
    this.interaction = interaction || null;
    this.message = message || null;
    this.cmd = cmd; this.sub = sub || null; this.cfg = cfg;
    this.src = interaction || message;
    this.guild = this.src.guild;
    this.channel = this.src.channel;
    this.user = interaction ? interaction.user : message.author;
    this.member = interaction ? interaction.member : message.member;
    this.args = {};
    this.sent = false;
  }
  get isSlash() { return !!this.interaction; }
  async defer(ephemeral = false) {
    if (this.isSlash) {
      if (!this.interaction.deferred && !this.interaction.replied) {
        await this.interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
      }
    } else {
      await this.channel.sendTyping().catch(() => {});
    }
  }
  async reply(payload, { ephemeral = false, deleteAfter = 0 } = {}) {
    const body = typeof payload === 'string' ? { content: payload } : { ...payload };
    body.allowedMentions = { parse: [] };
    let sent;
    if (this.isSlash) {
      const i = this.interaction;
      if (i.deferred && !this.sent) sent = await i.editReply(body);
      else if (i.deferred || i.replied) sent = await i.followUp({ ...body, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
      else sent = await i.reply({ ...body, flags: ephemeral ? MessageFlags.Ephemeral : undefined, fetchReply: true });
    } else {
      sent = await this.channel.send(body);
      if (deleteAfter) setTimeout(() => sent.delete().catch(() => {}), deleteAfter);
    }
    this.sent = true;
    return sent;
  }
  ok(text, opts) { return this.reply({ embeds: [embed(this.cfg, text)] }, opts); }
  fail(text) { return this.reply({ embeds: [failEmbed(text)] }, { ephemeral: true }); }
}

function addOptions(builder, opts) {
  for (const o of opts) {
    const base = (x) => x.setName(o.name).setDescription(o.description).setRequired(!!o.required);
    switch (o.type) {
      case 'user': builder.addUserOption(base); break;
      case 'role': builder.addRoleOption(base); break;
      case 'channel': builder.addChannelOption((x) => base(x).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)); break;
      case 'int': builder.addIntegerOption((x) => {
        base(x);
        if (o.min != null) x.setMinValue(o.min);
        if (o.max != null) x.setMaxValue(o.max);
        return x;
      }); break;
      default: builder.addStringOption((x) => {
        base(x);
        if (o.choices) x.addChoices(...o.choices.map((c) => ({ name: c, value: c })));
        if (o.maxLength) x.setMaxLength(o.maxLength);
        return x;
      });
    }
  }
}
function buildSlash(cmd) {
  const b = new SlashCommandBuilder().setName(cmd.name).setDescription(cmd.description).setContexts(0);
  if (cmd.perm) b.setDefaultMemberPermissions(cmd.perm);
  if (cmd.subs) {
    for (const [n, s] of Object.entries(cmd.subs)) {
      b.addSubcommand((sc) => { sc.setName(n).setDescription(s.description); addOptions(sc, s.options || []); return sc; });
    }
  } else addOptions(b, cmd.options || []);
  return b.toJSON();
}

function slashArgs(i, opts) {
  const a = {};
  for (const o of opts) {
    let v = null;
    switch (o.type) {
      case 'user': v = i.options.getUser(o.name); break;
      case 'role': v = i.options.getRole(o.name); break;
      case 'channel': v = i.options.getChannel(o.name); break;
      case 'int': v = i.options.getInteger(o.name); break;
      case 'duration': {
        const s = i.options.getString(o.name);
        if (s) {
          v = parseDuration(s);
          if (v == null) throw new UserError('That duration is not valid. Use values like 30m, 2h or 1d.');
        }
        break;
      }
      default: v = i.options.getString(o.name);
    }
    if (v != null) a[o.name] = v;
  }
  return a;
}

async function convertToken(o, tok, guild) {
  const idOf = (s) => s.replace(/[<@!&#>]/g, '');
  switch (o.type) {
    case 'user': {
      const id = idOf(tok);
      return /^\d{17,20}$/.test(id) ? client.users.fetch(id).catch(() => null) : null;
    }
    case 'role': { const id = idOf(tok); return /^\d{17,20}$/.test(id) ? guild.roles.cache.get(id) || null : null; }
    case 'channel': { const id = idOf(tok); return /^\d{17,20}$/.test(id) ? guild.channels.cache.get(id) || null : null; }
    case 'int': return /^-?\d+$/.test(tok) ? parseInt(tok, 10) : null;
    case 'duration': return parseDuration(tok);
    default:
      if (o.choices && !o.choices.includes(tok.toLowerCase())) return null;
      return o.choices ? tok.toLowerCase() : tok;
  }
}
async function prefixArgs(def, tokens, guild, usageText) {
  const out = {};
  let i = 0;
  for (const o of def.options || []) {
    if (o.rest) {
      const v = tokens.slice(i).join(' ');
      if (v) out[o.name] = v;
      i = tokens.length;
    } else if (tokens[i] !== undefined) {
      const v = await convertToken(o, tokens[i], guild);
      if (v !== null && v !== undefined) { out[o.name] = v; i++; }
    }
    if (out[o.name] === undefined && o.required) throw new UserError(`Missing or invalid \`${o.name}\`.\nUsage: ${usageText}`);
    if (o.type === 'int' && out[o.name] !== undefined) {
      if ((o.min != null && out[o.name] < o.min) || (o.max != null && out[o.name] > o.max)) {
        throw new UserError(`\`${o.name}\` must be between ${o.min ?? '-∞'} and ${o.max ?? '∞'}.`);
      }
    }
  }
  return out;
}
function usageOf(prefix, cmd, sub) {
  const def = sub ? cmd.subs[sub] : cmd;
  const parts = (def.options || []).map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`));
  return `\`${prefix}${cmd.name}${sub ? ' ' + sub : ''} ${parts.join(' ')}\``.replace(' `', '`');
}

async function execute(ctx) {
  const def = ctx.sub ? ctx.cmd.subs[ctx.sub] : ctx.cmd;
  const perm = def.perm || ctx.cmd.perm;
  if (perm && !ctx.member.permissions.has(perm)) throw new UserError('You do not have permission to use this command.');
  const me = ctx.guild.members.me;
  const needs = def.botPerms || ctx.cmd.botPerms;
  if (needs && !me.permissions.has(needs)) {
    const missing = new (require('discord.js').PermissionsBitField)(needs).missing(me.permissions);
    throw new UserError(`I am missing permissions: ${missing.join(', ')}.`);
  }
  await def.run(ctx, ctx.args);
}

async function handleError(ctx, err) {
  if (err instanceof UserError) return ctx.fail(err.message).catch(() => {});
  console.error(`Command error (${ctx.cmd?.name}):`, err);
  const text = 'Something went wrong while running that command. The error has been logged.';
  return ctx.fail(text).catch(() => {});
}

/* --------------------------- 5. MODERATION ------------------------------- */
const insertCase = db.prepare(
  'INSERT INTO cases (guild_id, num, type, user_id, mod_id, reason, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)'
);
function createCase(guild, type, userId, modId, reason, expiresAt = null) {
  const row = db.transaction(() => {
    const { n } = db.prepare('SELECT COALESCE(MAX(num), 0) + 1 AS n FROM cases WHERE guild_id = ?').get(guild.id);
    const info = insertCase.run(guild.id, n, type, userId, modId, reason, Date.now(), expiresAt);
    return db.prepare('SELECT * FROM cases WHERE id = ?').get(info.lastInsertRowid);
  })();
  logCase(guild, row).catch(() => {});
  return row;
}
function caseEmbed(cfg, c) {
  const e = new EmbedBuilder()
    .setColor(TYPE_COLOR[c.type] || 0x2b2540)
    .setTitle(`Case #${c.num} · ${TYPE_LABEL[c.type] || c.type}`)
    .addFields(
      { name: 'Member', value: `<@${c.user_id}> (${c.user_id})`, inline: true },
      { name: 'Moderator', value: `<@${c.mod_id}>`, inline: true },
      { name: 'Reason', value: clip(c.reason, 1000) },
    )
    .setTimestamp(c.created_at).setFooter({ text: FOOTER });
  if (c.expires_at) e.addFields({ name: 'Expires', value: ts(c.expires_at, 'f'), inline: true });
  return e;
}
async function logCase(guild, c) {
  const cfg = getConfig(guild.id);
  if (!cfg.mod_log_channel) return;
  const ch = guild.channels.cache.get(cfg.mod_log_channel);
  if (ch) await ch.send({ embeds: [caseEmbed(cfg, c)], allowedMentions: { parse: [] } });
}
async function dmUser(user, guild, title, reason, extra) {
  const e = new EmbedBuilder().setColor(0x2b2540).setTitle(`${title} in ${guild.name}`)
    .setDescription(`Reason: ${clip(reason, 1500)}${extra ? `\n${extra}` : ''}`).setFooter({ text: FOOTER });
  await user.send({ embeds: [e] }).catch(() => {});
}
function checkTarget(ctx, user, member) {
  if (user.id === ctx.user.id) throw new UserError('You cannot use this on yourself.');
  if (user.id === client.user.id) throw new UserError('I will not do that to myself.');
  if (user.id === ctx.guild.ownerId) throw new UserError('The server owner cannot be targeted.');
  if (!member) return;
  const me = ctx.guild.members.me;
  if (ctx.user.id !== ctx.guild.ownerId && member.roles.highest.position >= ctx.member.roles.highest.position) {
    throw new UserError('That member has a role equal to or higher than yours.');
  }
  if (member.roles.highest.position >= me.roles.highest.position) {
    throw new UserError('That member has a role equal to or higher than mine.');
  }
}
const auditReason = (ctx, reason) => clip(`${ctx.user.username}: ${reason}`, 500);
const reasonOf = (a) => a.reason || DEFAULT_REASON;
const requireMember = async (ctx, user) => {
  const m = await ctx.guild.members.fetch(user.id).catch(() => null);
  if (!m) throw new UserError('That user is not in this server.');
  return m;
};

define({
  name: 'warn', description: 'Warn a member', category: 'Moderation', perm: P.ModerateMembers,
  options: [opt('user', 'member', 'Member to warn', true), opt('string', 'reason', 'Reason', false, { rest: true })],
  async run(ctx, a) {
    const member = await requireMember(ctx, a.member);
    checkTarget(ctx, a.member, member);
    const c = createCase(ctx.guild, 'warn', a.member.id, ctx.user.id, reasonOf(a));
    await dmUser(a.member, ctx.guild, 'You were warned', c.reason);
    const total = db.prepare("SELECT COUNT(*) n FROM cases WHERE guild_id=? AND user_id=? AND type='warn' AND active=1").get(ctx.guild.id, a.member.id).n;
    await ctx.ok(`**${a.member.username}** has been warned. Case #${c.num}. Active warnings: ${total}.`);
  },
});
define({
  name: 'unwarn', description: 'Remove a warning from a member', category: 'Moderation', perm: P.ModerateMembers,
  options: [opt('user', 'member', 'Member', true), opt('int', 'case', 'Case number (defaults to the latest warning)', false, { min: 1 }),
    opt('string', 'reason', 'Reason', false, { rest: true })],
  async run(ctx, a) {
    const q = a.case
      ? db.prepare("SELECT * FROM cases WHERE guild_id=? AND user_id=? AND type='warn' AND active=1 AND num=?").get(ctx.guild.id, a.member.id, a.case)
      : db.prepare("SELECT * FROM cases WHERE guild_id=? AND user_id=? AND type='warn' AND active=1 ORDER BY num DESC LIMIT 1").get(ctx.guild.id, a.member.id);
    if (!q) throw new UserError('No matching active warning was found.');
    db.prepare('UPDATE cases SET active = 0 WHERE id = ?').run(q.id);
    const c = createCase(ctx.guild, 'unwarn', a.member.id, ctx.user.id, `${reasonOf(a)} (removed warning #${q.num})`);
    await ctx.ok(`Warning #${q.num} was removed from **${a.member.username}**. Case #${c.num}.`);
  },
});
define({
  name: 'warnings', description: 'View a member\'s active warnings', category: 'Moderation', perm: P.ModerateMembers,
  options: [opt('user', 'member', 'Member', true)],
  async run(ctx, a) {
    const rows = db.prepare("SELECT * FROM cases WHERE guild_id=? AND user_id=? AND type='warn' AND active=1 ORDER BY num DESC LIMIT 15").all(ctx.guild.id, a.member.id);
    if (!rows.length) return ctx.ok(`**${a.member.username}** has no active warnings.`);
    const lines = rows.map((r) => `**#${r.num}** ${ts(r.created_at)} by <@${r.mod_id}>\n${clip(r.reason, 200)}`);
    await ctx.reply({ embeds: [embed(ctx.cfg, lines.join('\n\n')).setTitle(`Warnings for ${a.member.username}`)] });
  },
});
define({
  name: 'clearwarnings', description: 'Clear all active warnings for a member', category: 'Moderation', perm: P.ModerateMembers,
  options: [opt('user', 'member', 'Member', true), opt('string', 'reason', 'Reason', false, { rest: true })],
  async run(ctx, a) {
    const info = db.prepare("UPDATE cases SET active=0 WHERE guild_id=? AND user_id=? AND type='warn' AND active=1").run(ctx.guild.id, a.member.id);
    if (!info.changes) throw new UserError('That member has no active warnings.');
    const c = createCase(ctx.guild, 'unwarn', a.member.id, ctx.user.id, `${reasonOf(a)} (cleared ${info.changes} warnings)`);
    await ctx.ok(`Cleared ${info.changes} warning${info.changes === 1 ? '' : 's'} for **${a.member.username}**. Case #${c.num}.`);
  },
});
define({
  name: 'history', description: 'View a member\'s full moderation history', category: 'Moderation', perm: P.ModerateMembers,
  options: [opt('user', 'member', 'Member', true)],
  async run(ctx, a) {
    const rows = db.prepare('SELECT * FROM cases WHERE guild_id=? AND user_id=? ORDER BY num DESC LIMIT 20').all(ctx.guild.id, a.member.id);
    if (!rows.length) return ctx.ok(`**${a.member.username}** has a clean record.`);
    const lines = rows.map((r) => `**#${r.num}** ${TYPE_LABEL[r.type] || r.type} · ${ts(r.created_at)}\n${clip(r.reason, 150)}`);
    await ctx.reply({ embeds: [embed(ctx.cfg, lines.join('\n\n')).setTitle(`History for ${a.member.username}`).setFooter({ text: `${FOOTER} · latest 20 cases` })] });
  },
});

const MAX_TIMEOUT = 28 * 86
