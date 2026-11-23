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

const MAX_TIMEOUT = 28 * 864e5;
define({
  name: 'mute', description: 'Time out a member', category: 'Moderation', perm: P.ModerateMembers, botPerms: P.ModerateMembers, aliases: ['timeout'],
  options: [opt('user', 'member', 'Member', true), opt('duration', 'duration', 'e.g. 10m, 2h, 1d (max 28d)', true),
    opt('string', 'reason', 'Reason', false, { rest: true })],
  async run(ctx, a) {
    if (a.duration > MAX_TIMEOUT) throw new UserError('Discord limits timeouts to 28 days.');
    const member = await requireMember(ctx, a.member);
    checkTarget(ctx, a.member, member);
    if (!member.moderatable) throw new UserError('I cannot time out that member.');
    await member.timeout(a.duration, auditReason(ctx, reasonOf(a)));
    db.prepare("UPDATE cases SET active=0 WHERE guild_id=? AND user_id=? AND type='mute' AND active=1").run(ctx.guild.id, a.member.id);
    const c = createCase(ctx.guild, 'mute', a.member.id, ctx.user.id, reasonOf(a), Date.now() + a.duration);
    await dmUser(a.member, ctx.guild, 'You were timed out', c.reason, `Duration: ${fmtDuration(a.duration)}`);
    await ctx.ok(`**${a.member.username}** is timed out for ${fmtDuration(a.duration)}. Case #${c.num}.`);
  },
});
const unmuteRun = async (ctx, a) => {
  const member = await requireMember(ctx, a.member);
  if (!member.isCommunicationDisabled()) throw new UserError('That member is not timed out.');
  await member.timeout(null, auditReason(ctx, reasonOf(a)));
  db.prepare("UPDATE cases SET active=0 WHERE guild_id=? AND user_id=? AND type='mute' AND active=1").run(ctx.guild.id, a.member.id);
  const c = createCase(ctx.guild, 'unmute', a.member.id, ctx.user.id, reasonOf(a));
  await ctx.ok(`Timeout removed from **${a.member.username}**. Case #${c.num}.`);
};
const unmuteOpts = [opt('user', 'member', 'Member', true), opt('string', 'reason', 'Reason', false, { rest: true })];
define({ name: 'unmute', description: 'Remove a timeout', category: 'Moderation', perm: P.ModerateMembers, botPerms: P.ModerateMembers, options: unmuteOpts, run: unmuteRun });
define({ name: 'untimeout', description: 'Remove a timeout', category: 'Moderation', perm: P.ModerateMembers, botPerms: P.ModerateMembers, options: unmuteOpts, run: unmuteRun });
define({
  name: 'mutelist', description: 'List members currently timed out', category: 'Moderation', perm: P.ModerateMembers,
  async run(ctx) {
    const rows = db.prepare("SELECT * FROM cases WHERE guild_id=? AND type='mute' AND active=1 AND expires_at > ? ORDER BY expires_at").all(ctx.guild.id, Date.now());
    if (!rows.length) return ctx.ok('Nobody is currently timed out.');
    const lines = rows.slice(0, 25).map((r) => `<@${r.user_id}> · ends ${ts(r.expires_at)} · case #${r.num}`);
    await ctx.reply({ embeds: [embed(ctx.cfg, lines.join('\n')).setTitle('Active timeouts')] });
  },
});

define({
  name: 'kick', description: 'Kick a member', category: 'Moderation', perm: P.KickMembers, botPerms: P.KickMembers,
  options: [opt('user', 'member', 'Member', true), opt('string', 'reason', 'Reason', false, { rest: true })],
  async run(ctx, a) {
    const member = await requireMember(ctx, a.member);
    checkTarget(ctx, a.member, member);
    if (!member.kickable) throw new UserError('I cannot kick that member.');
    await dmUser(a.member, ctx.guild, 'You were kicked', reasonOf(a));
    await member.kick(auditReason(ctx, reasonOf(a)));
    const c = createCase(ctx.guild, 'kick', a.member.id, ctx.user.id, reasonOf(a));
    await ctx.ok(`**${a.member.username}** was kicked. Case #${c.num}.`);
  },
});

async function banFlow(ctx, a, { type, days = 0, expires = null }) {
  const member = await ctx.guild.members.fetch(a.member.id).catch(() => null);
  checkTarget(ctx, a.member, member);
  if (member && !member.bannable) throw new UserError('I cannot ban that member.');
  const reason = reasonOf(a);
  await dmUser(a.member, ctx.guild, type === 'tempban' ? 'You were temporarily banned' : 'You were banned', reason,
    expires ? `Ban ends ${ts(expires, 'f')}.` : '');
  await ctx.guild.members.ban(a.member.id, { reason: auditReason(ctx, reason), deleteMessageSeconds: days * 86400 });
  if (type === 'softban') await ctx.guild.bans.remove(a.member.id, 'Softban').catch(() => {});
  return createCase(ctx.guild, type, a.member.id, ctx.user.id, reason, expires);
}
define({
  name: 'ban', description: 'Ban a member or user ID', category: 'Moderation', perm: P.BanMembers, botPerms: P.BanMembers,
  options: [opt('user', 'member', 'User to ban', true), opt('int', 'days', 'Days of messages to delete (0-7)', false, { min: 0, max: 7 }),
    opt('string', 'reason', 'Reason', false, { rest: true })],
  async run(ctx, a) {
    const c = await banFlow(ctx, a, { type: 'ban', days: a.days || 0 });
    await ctx.ok(`**${a.member.username}** was banned. Case #${c.num}.`);
  },
});
define({
  name: 'softban', description: 'Ban and immediately unban to remove recent messages', category: 'Moderation', perm: P.BanMembers, botPerms: P.BanMembers,
  options: [opt('user', 'member', 'Member', true), opt('string', 'reason', 'Reason', false, { rest: true })],
  async run(ctx, a) {
    const c = await banFlow(ctx, a, { type: 'softban', days: 1 });
    await ctx.ok(`**${a.member.username}** was softbanned. Case #${c.num}.`);
  },
});
define({
  name: 'tempban', description: 'Ban a member for a set time', category: 'Moderation', perm: P.BanMembers, botPerms: P.BanMembers,
  options: [opt('user', 'member', 'Member', true), opt('duration', 'duration', 'e.g. 12h, 3d, 2w', true),
    opt('string', 'reason', 'Reason', false, { rest: true })],
  async run(ctx, a) {
    const c = await banFlow(ctx, a, { type: 'tempban', expires: Date.now() + a.duration });
    await ctx.ok(`**${a.member.username}** is banned for ${fmtDuration(a.duration)}. Case #${c.num}.`);
  },
});
define({
  name: 'unban', description: 'Unban a user', category: 'Moderation', perm: P.BanMembers, botPerms: P.BanMembers,
  options: [opt('user', 'member', 'User to unban', true), opt('string', 'reason', 'Reason', false, { rest: true })],
  async run(ctx, a) {
    const ban = await ctx.guild.bans.fetch(a.member.id).catch(() => null);
    if (!ban) throw new UserError('That user is not banned.');
    await ctx.guild.bans.remove(a.member.id, auditReason(ctx, reasonOf(a)));
    db.prepare("UPDATE cases SET active=0 WHERE guild_id=? AND user_id=? AND type='tempban' AND active=1").run(ctx.guild.id, a.member.id);
    const c = createCase(ctx.guild, 'unban', a.member.id, ctx.user.id, reasonOf(a));
    await ctx.ok(`**${a.member.username}** was unbanned. Case #${c.num}.`);
  },
});

define({
  name: 'nickname', description: 'Change a member\'s nickname', category: 'Moderation', perm: P.ManageNicknames, botPerms: P.ManageNicknames,
  options: [opt('user', 'member', 'Member', true), opt('string', 'nickname', 'New nickname', true, { rest: true, maxLength: 32 })],
  async run(ctx, a) {
    const member = await requireMember(ctx, a.member);
    if (a.member.id !== ctx.user.id) checkTarget(ctx, a.member, member);
    if (a.nickname.length > 32) throw new UserError('Nicknames can be at most 32 characters.');
    if (!member.manageable) throw new UserError('I cannot change that member\'s nickname.');
    await member.setNickname(a.nickname, auditReason(ctx, 'Nickname change'));
    await ctx.ok(`Nickname for **${a.member.username}** set to **${a.nickname}**.`);
  },
});
define({
  name: 'resetnickname', description: 'Reset a member\'s nickname', category: 'Moderation', perm: P.ManageNicknames, botPerms: P.ManageNicknames,
  options: [opt('user', 'member', 'Member', true)],
  async run(ctx, a) {
    const member = await requireMember(ctx, a.member);
    if (a.member.id !== ctx.user.id) checkTarget(ctx, a.member, member);
    if (!member.manageable) throw new UserError('I cannot change that member\'s nickname.');
    await member.setNickname(null, auditReason(ctx, 'Nickname reset'));
    await ctx.ok(`Nickname for **${a.member.username}** was reset.`);
  },
});

// Channel management
const textChannelOf = (ctx, a) => {
  const ch = a.channel || ctx.channel;
  if (!ch.permissionOverwrites) throw new UserError('Choose a server text channel.');
  return ch;
};
define({
  name: 'lock', description: 'Stop @everyone from sending messages in a channel', category: 'Moderation', perm: P.ManageChannels, botPerms: P.ManageChannels,
  options: [opt('channel', 'channel', 'Channel (defaults to this one)')],
  async run(ctx, a) {
    const ch = textChannelOf(ctx, a);
    await ch.permissionOverwrites.edit(ctx.guild.roles.everyone, { SendMessages: false }, { reason: auditReason(ctx, 'Channel locked') });
    await ctx.ok(`<#${ch.id}> is now locked.`);
  },
});
define({
  name: 'unlock', description: 'Allow @everyone to send messages in a channel again', category: 'Moderation', perm: P.ManageChannels, botPerms: P.ManageChannels,
  options: [opt('channel', 'channel', 'Channel (defaults to this one)')],
  async run(ctx, a) {
    const ch = textChannelOf(ctx, a);
    await ch.permissionOverwrites.edit(ctx.guild.roles.everyone, { SendMessages: null }, { reason: auditReason(ctx, 'Channel unlocked') });
    await ctx.ok(`<#${ch.id}> is now unlocked.`);
  },
});
define({
  name: 'slowmode', description: 'Set a channel\'s slowmode', category: 'Moderation', perm: P.ManageChannels, botPerms: P.ManageChannels,
  options: [opt('int', 'seconds', 'Seconds between messages (1-21600)', true, { min: 1, max: 21600 }), opt('channel', 'channel', 'Channel (defaults to this one)')],
  async run(ctx, a) {
    const ch = textChannelOf(ctx, a);
    await ch.setRateLimitPerUser(a.seconds, auditReason(ctx, 'Slowmode'));
    await ctx.ok(`Slowmode in <#${ch.id}> is now ${fmtDuration(a.seconds * 1000)}.`);
  },
});
define({
  name: 'unslowmode', description: 'Remove a channel\'s slowmode', category: 'Moderation', perm: P.ManageChannels, botPerms: P.ManageChannels,
  options: [opt('channel', 'channel', 'Channel (defaults to this one)')],
  async run(ctx, a) {
    const ch = textChannelOf(ctx, a);
    await ch.setRateLimitPerUser(0, auditReason(ctx, 'Slowmode removed'));
    await ctx.ok(`Slowmode removed from <#${ch.id}>.`);
  },
});

// Message deletion
const SCAN_LIMIT = 5000;
async function collectMessages(channel, filter, amount) {
  const found = [];
  let before, scanned = 0;
  while (scanned < SCAN_LIMIT && (!amount || found.length < amount)) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    scanned += batch.size;
    before = batch.last().id;
    for (const m of batch.values()) {
      if (m.pinned || m.system || !filter(m)) continue;
      found.push(m);
      if (amount && found.length >= amount) break;
    }
  }
  return found;
}
const delOne = (m) => m.delete().then(() => true).catch(() => false);
async function deleteMessages(channel, msgs, canBulk) {
  let deleted = 0;
  const cutoff = Date.now() - 14 * 864e5 + 60e3; // stay clear of the 14-day edge
  const recent = canBulk ? msgs.filter((m) => m.createdTimestamp > cutoff) : [];
  const single = canBulk ? msgs.filter((m) => m.createdTimestamp <= cutoff) : msgs;
  for (let i = 0; i < recent.length; i += 100) {
    const chunk = recent.slice(i, i + 100);
    if (chunk.length > 1) {
      const res = await channel.bulkDelete(chunk, true).catch(() => null);
      if (res) { deleted += res.size; continue; }
    }
    for (const m of chunk) if (await delOne(m)) deleted++;
  }
  for (const m of single) if (await delOne(m)) deleted++;
  return deleted;
}
async function sweep(ctx, a, { name, filter, needsManage }) {
  const ch = ctx.channel;
  const myPerms = ch.permissionsFor(ctx.guild.members.me);
  if (!myPerms.has([P.ViewChannel, P.ReadMessageHistory])) throw new UserError('I need View Channel and Read Message History here.');
  if (needsManage && !myPerms.has(P.ManageMessages)) throw new UserError('I need Manage Messages in this channel.');
  await ctx.defer(true);
  if (!ctx.isSlash && name === 'purge') await ctx.message.delete().catch(() => {}); // the command message is human-sent
  const msgs = await collectMessages(ch, filter, a.amount);
  const deleted = await deleteMessages(ch, msgs, myPerms.has(P.ManageMessages));
  const skipped = msgs.length - deleted;
  const text = deleted
    ? `Deleted ${deleted} ${name === 'clean' ? 'of my messages' : 'member messages'}${skipped ? `; ${skipped} could not be removed` : ''}.`
    : 'There was nothing I could delete.';
  await ctx.ok(text, { deleteAfter: 6000 });
}
define({
  name: 'clean', description: 'Delete Wands of Fate messages in this channel', category: 'Moderation', perm: P.ManageMessages,
  options: [opt('int', 'amount', 'How many of my messages to delete (default: all)', false, { min: 1, max: 1000 })],
  run: (ctx, a) => sweep(ctx, a, { name: 'clean', needsManage: false, filter: (m) => m.author.id === client.user.id }),
});
define({
  name: 'purge', description: 'Delete messages from human members in this channel', category: 'Moderation', perm: P.ManageMessages, botPerms: P.ManageMessages,
  options: [opt('int', 'amount', 'How many member messages to delete (default: all)', false, { min: 1, max: 1000 })],
  run: (ctx, a) => sweep(ctx, a, { name: 'purge', needsManage: true, filter: (m) => !m.author.bot && !m.webhookId }),
});
define({
  name: 'clear', description: 'Delete the most recent messages regardless of author', category: 'Moderation', perm: P.ManageMessages, botPerms: P.ManageMessages,
  options: [opt('int', 'amount', 'Messages to delete (1-100)', true, { min: 1, max: 100 })],
  async run(ctx, a) {
    await ctx.defer(true);
    if (!ctx.isSlash) await ctx.message.delete().catch(() => {});
    const res = await ctx.channel.bulkDelete(a.amount, true).catch(() => null);
    if (!res) throw new UserError('I could not delete messages here.');
    await ctx.ok(`Deleted ${res.size} message${res.size === 1 ? '' : 's'}. Messages older than 14 days are skipped.`, { deleteAfter: 6000 });
  },
});

// Records
define({
  name: 'case', description: 'View a moderation case', category: 'Moderation', perm: P.ModerateMembers,
  options: [opt('int', 'number', 'Case number', true, { min: 1 })],
  async run(ctx, a) {
    const c = db.prepare('SELECT * FROM cases WHERE guild_id=? AND num=?').get(ctx.guild.id, a.number);
    if (!c) throw new UserError(`Case #${a.number} does not exist.`);
    await ctx.reply({ embeds: [caseEmbed(ctx.cfg, c)] });
  },
});
define({
  name: 'reason', description: 'Update the reason of a case', category: 'Moderation', perm: P.ModerateMembers,
  options: [opt('int', 'number', 'Case number', true, { min: 1 }), opt('string', 'reason', 'New reason', true, { rest: true })],
  async run(ctx, a) {
    const info = db.prepare('UPDATE cases SET reason=? WHERE guild_id=? AND num=?').run(a.reason, ctx.guild.id, a.number);
    if (!info.changes) throw new UserError(`Case #${a.number} does not exist.`);
    await ctx.ok(`Reason for case #${a.number} updated.`);
  },
});
define({
  name: 'modlogs', description: 'View recent moderation cases', category: 'Moderation', perm: P.ModerateMembers,
  options: [opt('user', 'member', 'Only show cases for this member')],
  async run(ctx, a) {
    const rows = a.member
      ? db.prepare('SELECT * FROM cases WHERE guild_id=? AND user_id=? ORDER BY num DESC LIMIT 15').all(ctx.guild.id, a.member.id)
      : db.prepare('SELECT * FROM cases WHERE guild_id=? ORDER BY num DESC LIMIT 15').all(ctx.guild.id);
    if (!rows.length) return ctx.ok('No cases recorded yet.');
    const lines = rows.map((r) => `**#${r.num}** ${TYPE_LABEL[r.type] || r.type} · <@${r.user_id}> · ${ts(r.created_at)}\n${clip(r.reason, 120)}`);
    await ctx.reply({ embeds: [embed(ctx.cfg, lines.join('\n\n')).setTitle('Moderation log')] });
  },
});

/* ------------------------------ 6. CONFIG -------------------------------- */
define({
  name: 'prefix', description: 'View or change this server\'s prefix', category: 'Configuration', perm: P.ManageGuild,
  subs: {
    set: {
      description: 'Set the prefix for this server',
      options: [opt('string', 'prefix', 'New prefix (1-5 characters, no spaces)', true, { maxLength: 5 })],
      async run(ctx, a) {
        if (/\s/.test(a.prefix) || a.prefix.length > 5) throw new UserError('The prefix must be 1 to 5 characters with no spaces.');
        setConfig(ctx.guild.id, 'prefix', a.prefix);
        await ctx.ok(`Prefix set to \`${a.prefix}\`. Slash commands are not affected.`);
      },
    },
    show: {
      description: 'Show the current prefix',
      async run(ctx) { await ctx.ok(`The prefix here is \`${getConfig(ctx.guild.id).prefix}\`.`); },
    },
  },
});
define({
  name: 'setlogs', description: 'Set the moderation log channel', category: 'Configuration', perm: P.ManageGuild,
  options: [opt('channel', 'channel', 'Log channel (omit to disable logging)')],
  async run(ctx, a) {
    if (!a.channel) { setConfig(ctx.guild.id, 'mod_log_channel', null); return ctx.ok('Moderation logging is now disabled.'); }
    const perms = a.channel.permissionsFor(ctx.guild.members.me);
    if (!perms?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) throw new UserError('I cannot send embeds in that channel.');
    setConfig(ctx.guild.id, 'mod_log_channel', a.channel.id);
    await ctx.ok(`Moderation logs will be sent to <#${a.channel.id}>.`);
  },
});
define({
  name: 'config', description: 'View or change server settings', category: 'Configuration', perm: P.ManageGuild,
  subs: {
    show: {
      description: 'Show current settings',
      async run(ctx) {
        const c = getConfig(ctx.guild.id);
        await ctx.reply({ embeds: [embed(ctx.cfg).setTitle('Server configuration').addFields(
          { name: 'Prefix', value: `\`${c.prefix}\``, inline: true },
          { name: 'Embed color', value: c.color, inline: true },
          { name: 'Moderation logs', value: c.mod_log_channel ? `<#${c.mod_log_channel}>` : 'Not set', inline: true },
        )] });
      },
    },
    color: {
      description: 'Set the embed color',
      options: [opt('string', 'hex', 'Hex color such as #2b2540', true, { maxLength: 7 })],
      async run(ctx, a) {
        const hex = a.hex.startsWith('#') ? a.hex : `#${a.hex}`;
        if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new UserError('Provide a six-digit hex color like #2b2540.');
        setConfig(ctx.guild.id, 'color', hex.toLowerCase());
        await ctx.reply({ embeds: [embed({ color: hex }, `Embed color set to ${hex.toLowerCase()}.`)] });
      },
    },
  },
});

/* ------------------------------- 7. INFO --------------------------------- */
define({
  name: 'userinfo', description: 'Show information about a member', category: 'Utility',
  options: [opt('user', 'member', 'Member (defaults to you)')],
  async run(ctx, a) {
    const user = a.member || ctx.user;
    const member = await ctx.guild.members.fetch(user.id).catch(() => null);
    const e = embed(ctx.cfg).setTitle(user.username).setThumbnail(user.displayAvatarURL()).addFields(
      { name: 'ID', value: user.id, inline: true },
      { name: 'Account created', value: ts(user.createdTimestamp, 'D'), inline: true },
    );
    if (member) {
      const roles = member.roles.cache.filter((r) => r.id !== ctx.guild.id).sort((x, y) => y.position - x.position).map((r) => `<@&${r.id}>`);
      e.addFields({ name: 'Joined', value: ts(member.joinedTimestamp, 'D'), inline: true },
        { name: `Roles (${roles.length})`, value: clip(roles.slice(0, 15).join(' ') || 'None', 1000) });
    }
    const n = db.prepare('SELECT COUNT(*) n FROM cases WHERE guild_id=? AND user_id=?').get(ctx.guild.id, user.id).n;
    e.addFields({ name: 'Moderation cases', value: String(n), inline: true });
    await ctx.reply({ embeds: [e] });
  },
});
define({
  name: 'serverinfo', description: 'Show information about this server', category: 'Utility',
  async run(ctx) {
    const g = ctx.guild;
    await ctx.reply({ embeds: [embed(ctx.cfg).setTitle(g.name).setThumbnail(g.iconURL()).addFields(
      { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
      { name: 'Created', value: ts(g.createdTimestamp, 'D'), inline: true },
      { name: 'Members', value: String(g.memberCount), inline: true },
      { name: 'Channels', value: String(g.channels.cache.size), inline: true },
      { name: 'Roles', value: String(g.roles.cache.size), inline: true },
      { name: 'Boosts', value: String(g.premiumSubscriptionCount || 0), inline: true },
    )] });
  },
});
define({
  name: 'help', description: 'List available commands', category: 'Utility',
  async run(ctx) {
    const by = {};
    for (const c of commands) (by[c.category] ||= []).push(c);
    const e = embed(ctx.cfg).setTitle('Wands of Fate').setDescription(`Prefix: \`${ctx.cfg.prefix}\` · Slash commands use \`/\``);
    for (const [cat, list] of Object.entries(by)) e.addFields({ name: cat, value: list.map((c) => `\`${c.name}\``).join(' ') });
    await ctx.reply({ embeds: [e] });
  },
});

/* ---------------------- 7a. MAGICAL CONTENT LIBRARY ---------------------- */
// The library is written into the code: curated entries by hand, the rest generated once at startup from
// fixed word banks with fixed seeds, so every entry (and its id) is identical on every start. No AI or network at runtime.
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythical', 'Forbidden'];
const RARITY_COLOR = [0x8d8d99, 0x4a7c59, 0x3b6ea5, 0x7a4fb0, 0xc9a227, 0xb03a6b, 0x7a1f2b];
const DROP_RATES = [42, 27, 16, 9, 4, 1.7, 0.3]; // percent per discovery, sums to 100
const CATS = {
  spell: 'Spells', curse: 'Curses', charm: 'Charms', enchantment: 'Enchantments', potion: 'Potions',
  creature: 'Magical Creatures', artifact: 'Artifacts', book: 'Ancient Books', location: 'Magical Locations',
  prophecy: 'Prophecies', relic: 'Relics', plant: 'Magical Plants', forbidden: 'Forbidden Knowledge', ritual: 'Ancient Rituals',
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = mulberry32(1);
const seedRng = (n) => { rng = mulberry32(n); };
const pick = (a) => a[Math.floor(rng() * a.length)];
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Each theme: boon (beneficial effects), bane (harmful effects), lore (behaviour), adj/noun (English name parts).
const THEMES = {
  shadow: {
    boon: ['Dims every flame within thirty paces.', 'Lets the bearer pass unseen while standing perfectly still.', 'Folds a pool of shadow into a hiding place for small objects.'],
    bane: ['Peels the target\'s shadow away, leaving them unable to rest in darkness.', 'Fills the target\'s sleep with a corridor that has no end.', 'Makes every dim room feel watched.'],
    lore: ['It casts no shadow of its own.', 'It is only visible at the edge of sight.', 'It gathers wherever candles have just been snuffed.'],
    adj: ['Hollow', 'Veiled', 'Unlit', 'Sunken', 'Muted'], noun: ['Midnight', 'Eclipse', 'Dusk', 'Umbra', 'Gloaming'],
  },
  light: {
    boon: ['Floods a chamber with warm light that reveals what is hidden.', 'Mends small wounds with a slow golden glow.', 'Turns a shut door pale until it can be seen through.'],
    bane: ['Blinds the target to everything except their own mistakes.', 'Burns the target\'s name from the memory of casual acquaintances.', 'Makes the target glow faintly, so they can never hide.'],
    lore: ['It glows brighter the closer a lie is spoken.', 'It rests in sunbeams and fades at dusk.', 'It leaves a faint halo on whatever it touches.'],
    adj: ['Gilded', 'Radiant', 'Dawnlit', 'Pale', 'Burnished'], noun: ['Daybreak', 'Halo', 'Sunrise', 'Glimmer', 'Brightness'],
  },
  death: {
    boon: ['Quiets restless spirits within a day\'s walk.', 'Lets the user put one question to the recently departed.', 'Slows decay on anything it touches for a season.'],
    bane: ['Withers the target\'s luck until a full moon has passed.', 'Chills the target\'s breath so that every word frosts.', 'Drains the colour from the target\'s belongings.'],
    lore: ['It walks only where something once ended.', 'It is cold to the touch in every season.', 'It is followed by the faint smell of old roses.'],
    adj: ['Bone-white', 'Withered', 'Ashen', 'Silent', 'Funereal'], noun: ['Requiem', 'Cypress', 'Ossuary', 'Lament', 'Vigil'],
  },
  star: {
    boon: ['Fixes the user\'s course by a star not currently in the sky.', 'Shows the constellations that governed the target\'s birth.', 'Lends a night of perfect clarity of thought.'],
    bane: ['Scatters the target\'s sense of direction across the sky.', 'Mislabels the stars for anyone who looks up near the target.', 'Leaves the target unable to finish any plan before dawn.'],
    lore: ['It is said to have fallen on a night with no moon.', 'It gleams with colours that belong to no known star.', 'It turns slowly to follow the brightest point overhead.'],
    adj: ['Starlit', 'Distant', 'Wandering', 'Falling', 'Argent'], noun: ['Comet', 'Zenith', 'Constellation', 'Meteor', 'Firmament'],
  },
  mind: {
    boon: ['Sharpens one memory until it can be examined like an object.', 'Lets two willing people share a single thought.', 'Quiets a restless mind enough to sleep.'],
    bane: ['Misplaces the target\'s most recent memory.', 'Makes the target repeat the last sentence they heard.', 'Fills the target\'s mind with a song they cannot name.'],
    lore: ['It repeats whatever is thought near it.', 'It pauses whenever someone nearby is deciding.', 'It has never been seen to sleep.'],
    adj: ['Lucid', 'Dreaming', 'Hushed', 'Labyrinthine', 'Forgotten'], noun: ['Thought', 'Reverie', 'Memory', 'Riddle', 'Echo'],
  },
  wild: {
    boon: ['Coaxes a stalled garden to bloom out of season.', 'Lets the user be understood by one animal for an hour.', 'Roots to the spot anything that tries to flee.'],
    bane: ['Entangles the target\'s footsteps in creeping vines.', 'Turns the target\'s bread to moss.', 'Sends nearby birds into a silent circle above the target.'],
    lore: ['It follows the oldest paths through any forest.', 'It lives only where no road has been laid.', 'It is quiet in a way that makes birds stop singing.'],
    adj: ['Mossbound', 'Thorned', 'Verdant', 'Feral', 'Twilit'], noun: ['Bramble', 'Antler', 'Canopy', 'Wildwood', 'Briar'],
  },
  water: {
    boon: ['Draws drinkable water from bare stone.', 'Lets the user walk across still water for the length of a held breath.', 'Calls up a fog to hide a small gathering.'],
    bane: ['Fills the target\'s ears with the sound of the sea.', 'Makes the target\'s footprints fill with water.', 'Keeps rain falling on the target alone.'],
    lore: ['It leaves wet footprints even on dry stone.', 'It is heard long before it is seen, like distant surf.', 'It thrives only where rivers meet.'],
    adj: ['Drowned', 'Tidal', 'Mirrored', 'Misted', 'Brine-touched'], noun: ['Tide', 'Undertow', 'Lagoon', 'Deepwater', 'Rainfall'],
  },
  wind: {
    boon: ['Carries a whispered message for a mile.', 'Lifts the user\'s voice so it is heard across a valley.', 'Slows a fall to the pace of a drifting leaf.'],
    bane: ['Sets every door near the target banging at midnight.', 'Steals the target\'s voice into the wind for a day.', 'Spins the target\'s belongings in a slow circle that will not settle.'],
    lore: ['It never rests, drifting from window to window.', 'It rides storm fronts and sheds feathers that crumble to ash.', 'It is seen only when grass bends against the breeze.'],
    adj: ['Restless', 'Gale-borne', 'Feathered', 'Whispering', 'Skybound'], noun: ['Gale', 'Zephyr', 'Windfall', 'Squall', 'Updraft'],
  },
  flame: {
    boon: ['Wakes any cold hearth with a single coal-warm breath.', 'Keeps a small flame alive through rain for a night.', 'Warms a cold room without a fire.'],
    bane: ['Raises welts like scorch marks on the target\'s hands.', 'Makes the target\'s candle smoke without ever lighting.', 'Leaves the target\'s words smelling of ash.'],
    lore: ['It warms whoever stands nearest.', 'It smoulders softly in damp weather.', 'It is drawn to unlit lamps.'],
    adj: ['Ember-lit', 'Smouldering', 'Cinder-black', 'Kindled', 'Soot-gold'], noun: ['Ember', 'Hearth', 'Cinder', 'Pyre', 'Wildfire'],
  },
  stone: {
    boon: ['Hardens clothing into a thin plate for a moment.', 'Lets the user hear what the stones beneath them remember.', 'Seals a crack or a doorway until the next dawn.'],
    bane: ['Slows the target\'s limbs to the pace of settling ground.', 'Weighs the target\'s pockets with pebbles that vanish when counted.', 'Locks the target\'s joints for the length of one breath.'],
    lore: ['It is slow, patient and almost impossible to move.', 'It is mistaken for part of the cliff until it blinks.', 'It collects at the foot of old walls.'],
    adj: ['Ancient', 'Basalt', 'Weathered', 'Unmoving', 'Rune-carved'], noun: ['Monolith', 'Cairn', 'Bedrock', 'Obelisk', 'Cavern'],
  },
  blood: {
    boon: ['Reveals shared ancestry between any two people nearby.', 'Steadies a failing pulse for an hour.', 'Binds a promise so that breaking it is felt by both parties.'],
    bane: ['Makes the target\'s heartbeat audible to everyone nearby.', 'Fades the target\'s family resemblance in every portrait.', 'Leaves the target restless with a debt they cannot place.'],
    lore: ['It is drawn to oaths and unpaid debts.', 'It stains whatever it rests upon a faint rust colour.', 'It is kept only by families that remember its first owner.'],
    adj: ['Crimson', 'Sworn', 'Ancestral', 'Rust-red', 'Kindred'], noun: ['Oath', 'Lineage', 'Vein', 'Bloodline', 'Covenant'],
  },
  time: {
    boon: ['Stretches the next minute to hold an hour of thought.', 'Rewinds one dropped object back into the user\'s hand.', 'Shows a room as it looked at the same hour last year.'],
    bane: ['Leaves the target a heartbeat behind everyone else.', 'Ages the target\'s clothes by decades overnight.', 'Traps the target in an endless, unfinished yawn.'],
    lore: ['It runs slightly ahead of its surroundings.', 'It is found where clocks disagree.', 'It has no age that anyone can agree upon.'],
    adj: ['Unwound', 'Borrowed', 'Ageless', 'Stilled', 'Turning'], noun: ['Hour', 'Moment', 'Epoch', 'Pendulum', 'Solstice'],
  },
  fate: {
    boon: ['Tilts the next coin toss in the user\'s favour.', 'Reveals which of two paths holds the less regret.', 'Trades one small coincidence for another.'],
    bane: ['Makes the target\'s small plans founder on coincidence.', 'Fills the target\'s dreams with a choice they never made.', 'Turns the target\'s luckiest habit against them.'],
    lore: ['It appears just before an important choice.', 'It is recorded in three different centuries with the same face.', 'It is rumoured to know your name already.'],
    adj: ['Threadbare', 'Fated', 'Unwritten', 'Crossed', 'Inevitable'], noun: ['Crossroads', 'Omen', 'Destiny', 'Wager', 'Thread'],
  },
};
const THEME_KEYS = Object.keys(THEMES);
// [nominative, genitive, theme]: used to build Latin-styled names such as "Umbra Mortis".
const LN = [
  ['Umbra', 'Umbrae', 'shadow'], ['Nox', 'Noctis', 'shadow'], ['Tenebrae', 'Tenebrarum', 'shadow'], ['Vesper', 'Vesperis', 'shadow'],
  ['Lux', 'Lucis', 'light'], ['Aurora', 'Aurorae', 'light'], ['Sol', 'Solis', 'light'], ['Fulgur', 'Fulguris', 'light'],
  ['Mors', 'Mortis', 'death'], ['Ossa', 'Ossium', 'death'], ['Cinis', 'Cineris', 'death'], ['Sepulcrum', 'Sepulcri', 'death'],
  ['Stella', 'Stellae', 'star'], ['Luna', 'Lunae', 'star'], ['Aether', 'Aetheris', 'star'], ['Astrum', 'Astri', 'star'],
  ['Mens', 'Mentis', 'mind'], ['Somnium', 'Somnii', 'mind'], ['Memoria', 'Memoriae', 'mind'], ['Oblivio', 'Oblivionis', 'mind'],
  ['Silva', 'Silvae', 'wild'], ['Lupus', 'Lupi', 'wild'], ['Corvus', 'Corvi', 'wild'], ['Rosa', 'Rosae', 'wild'],
  ['Aqua', 'Aquae', 'water'], ['Mare', 'Maris', 'water'], ['Glacies', 'Glaciei', 'water'], ['Pluvia', 'Pluviae', 'water'],
  ['Ventus', 'Venti', 'wind'], ['Aura', 'Aurae', 'wind'], ['Tempestas', 'Tempestatis', 'wind'], ['Penna', 'Pennae', 'wind'],
  ['Ignis', 'Ignis', 'flame'], ['Favilla', 'Favillae', 'flame'], ['Pyra', 'Pyrae', 'flame'], ['Carbo', 'Carbonis', 'flame'],
  ['Saxum', 'Saxi', 'stone'], ['Terra', 'Terrae', 'stone'], ['Cavea', 'Caveae', 'stone'], ['Mons', 'Montis', 'stone'],
  ['Sanguis', 'Sanguinis', 'blood'], ['Cor', 'Cordis', 'blood'], ['Iuramentum', 'Iuramenti', 'blood'], ['Stirps', 'Stirpis', 'blood'],
  ['Tempus', 'Temporis', 'time'], ['Hora', 'Horae', 'time'], ['Aevum', 'Aevi', 'time'], ['Clepsydra', 'Clepsydrae', 'time'],
  ['Fatum', 'Fati', 'fate'], ['Sors', 'Sortis', 'fate'], ['Fortuna', 'Fortunae', 'fate'], ['Augurium', 'Auguri', 'fate'],
];
const LN_T = {};
for (const n of LN) (LN_T[n[2]] ||= []).push(n);

const SYL_A = ['Vael', 'Mor', 'Cas', 'Ish', 'Thal', 'Orrin', 'Sev', 'Dun', 'Kel', 'Ner', 'Aur', 'Brin', 'Lor', 'Tess', 'Ael', 'Vor', 'Ren', 'Hal'];
const SYL_B = ['mere', 'wick', 'dane', 'ara', 'holt', 'vane', 'thorn', 'ell', 'mar', 'quill', 'ford', 'sael'];
const SYL_C = ['a', 'en', 'is', 'or', 'us', 'ith', 'ael', 'ine'];
const TITLES = ['the archivist', 'the hermit', 'the stargazer', 'the exiled magistrate', 'the cartographer', 'the apothecary', 'the bellfounder', 'the midwife-seer', 'the ferryman', 'the lamplighter'];
const place = () => pick(SYL_A) + pick(SYL_B);
const person = () => `${pick(TITLES)} ${pick(SYL_A)}${pick(SYL_C)}`;
const fullName = () => `${pick(SYL_A)}${pick(SYL_C)} ${pick(SYL_A)}${pick(['wick', 'dane', 'holt', 'vane', 'thorn', 'ford'])}`;

const OR_ITEM = [
  'First set down by {p} of {pl}, who never explained where the {w} came from.',
  'Taught in secret at {pl} until the house there was closed.',
  'Mentioned in the margins of a ledger kept by {p}.',
  'Known to three living practitioners, one of them {p}.',
  'Traced by scholars to {pl}, though {p} insisted it was far older.',
  'Carried out of {pl} by {p} and rarely spoken of afterwards.',
  'Listed in an inventory at {pl} under a different name entirely.',
  'Rediscovered by {p} inside a hollowed-out volume at {pl}.',
  'Reputedly refined over three generations at {pl}.',
  'Dismissed by {p} as a rumour, then quietly practised for decades.',
  'Attributed to {p}, though the dates do not agree.',
  'Kept in a sealed drawer at {pl} until the drawer was stolen.',
];
const OR_BEING = [
  'Sightings were first logged by {p} near {pl}.',
  '{p} kept one in a lantern at {pl} for a single winter.',
  'Common in the folklore of {pl}, where it is rarely named aloud.',
  'Described in a field journal by {p}, who was never seen near {pl} again.',
  'Known to the villagers of {pl} as a sign that the weather will turn.',
  'Occasionally found on the road to {pl}, always at dusk.',
];
const OR_PLACE = [
  'Charted by {p}, who left {pl} and found the way back only once.',
  'Locals of {pl} claim it is always a short walk from wherever you stand.',
  'First described in a traveller\'s letter from {pl}.',
  'Rarely visible from the main road to {pl}.',
  '{p} mapped its outline from memory, and no two maps agree.',
  'Said by the people of {pl} to move when no one is counting steps.',
];
const RUMORS = [
  'Rumour holds that it grows quieter when its name is spoken twice.',
  'Those who study it keep their notes in a language of their own invention.',
  'It is said to behave differently in the presence of someone grieving.',
  'Several accounts describe it as smaller than expected and heavier than it should be.',
  'No two reports agree on its first appearance, which suggests it has more than one.',
  'Practitioners avoid mentioning it at the dinner table.',
  'The only portrait of it was painted from a description given in a dream.',
  'Children in {pl} learn a rhyme about it, but nobody remembers the last line.',
  'It is reputed to be most reliable when it is least needed.',
  'Its reputation has outlasted every record of how it works.',
  'Scholars disagree on whether it is common or merely overlooked.',
  'A faint smell of cold rain is often reported near it.',
];
const dress = (pool, w) => `${pick(pool).replace('{p}', person()).replace('{pl}', place()).replace('{w}', w)} ${pick(RUMORS).replace('{pl}', place())}`;

const CASTING = ['whispered', 'traced in the air with two fingers', 'sung under the breath', 'spoken backwards', 'held in silence for three heartbeats', 'written on the back of the hand', 'spoken against the palm', 'hummed in a minor key'];
const COST = ['a breath of warmth', 'a held memory until dawn', 'a drop of ink', 'a strand of hair', 'a quiet minute', 'a day of the longest shadow', 'a borrowed name', 'the warmth of one hand'];
const LIFTED = ['an apology freely given', 'running water at dawn', 'a debt repaid in full', 'three nights of honest sleep', 'burning the thing that triggered it', 'a truth spoken aloud'];
const DURATION = ['one moon', 'a season', 'nine days', 'until broken', 'one long winter'];
const LASTS = ['an evening', 'one day', 'a week', 'until the next rain', 'a full moon'];
const RANGE = ['touch', 'a single room', 'line of sight', 'a doorway', 'a short walk'];
const BINDS = ['wood', 'glass', 'iron', 'cloth', 'bone', 'silver', 'leather', 'clay'];
const ENDURES = ['a year', 'a decade', 'a lifetime', 'until spoken against', 'three seasons'];
const BREW = ['one night', 'three days', 'a full moon', 'a single hour', 'seven dawns'];
const TASTE = ['bitter apple', 'cold iron', 'honeyed smoke', 'rain on slate', 'burnt sugar', 'pine resin', 'wet violets', 'crushed mint'];
const HABITAT = ['high moorland', 'flooded cellars', 'old orchards', 'salt marshes', 'abandoned libraries', 'cliffside caves', 'frozen lakes', 'ruined chapels', 'misty valleys', 'the roots of ancient trees'];
const TEMPER = ['shy', 'territorial', 'curious', 'solitary', 'protective', 'indifferent', 'playful', 'watchful'];
const WIELDED = ['one owner at a time', 'anyone who is not afraid', 'only the left-handed', 'whoever finds it first', 'a chosen heir', 'those who ask it politely'];
const WEIGHT = ['light as a feather', 'heavier than it looks', 'warm to hold', 'cold in every season', 'strangely balanced'];
const FOUND = ['behind a waterfall', 'under a frozen lake', 'beyond the last milestone', 'through an unlocked door in a locked house', 'at the end of a road missing from maps', 'inside a hollow hill', 'above the cloud line'];
const SEASON = ['the dark of winter', 'midsummer dusk', 'the first frost', 'any hour before dawn', 'a new moon', 'after heavy rain'];
const HARVEST = ['at first frost', 'under a new moon', 'before dawn', 'after rain', 'at midsummer noon', 'with the left hand only'];
const GROWS = ['in graveyard soil', 'on north-facing walls', 'beside still water', 'between paving stones', 'in the shade of standing stones', 'on bare rock'];
const SEALED = ['a lead-lined chest', 'an oath of silence', 'three locks and a riddle', 'a ward of salt', 'the vault of a ruined abbey', 'a page torn from every copy'];
const KNOWN = ['no living scholar', 'a single archivist', 'three recluses', 'one exile', 'a family that no longer speaks of it'];
const HOURS = ['before the first bird', 'at the turn of midnight', 'during an eclipse', 'at sunset', 'in the hour after rain', 'as the tide turns'];
const FULFIL = ['the next eclipse passes unobserved', 'a door is opened from the wrong side', 'the youngest of a household speaks first', 'a promise is kept too late', 'two rivers are crossed in one day', 'a stranger is welcomed without a question', 'the third bell stays silent'];
const EVENTS = ['turns its face from the sky', 'is spoken aloud in an empty hall', 'falls across a sleeping house', 'is carried over running water', 'is named by the youngest of the line', 'is counted for the ninth time'];
const CONSEQ = ['a seat long kept empty will be filled', 'the oldest oath in the valley will be broken', 'a door that was sealed will open from the other side', 'the one who waits will be the last to know', 'two rivals will share a single road', 'what was taken will return heavier than it left'];
const CURSEWORDS = ['Anathema', 'Maledictio', 'Execratio', 'Vexatio', 'Interdictio', 'Dolor', 'Venenum'];
const SUFFIX = ['ith', 'ara', 'alis', 'ora', 'ael', 'ine', 'enna', 'ion', 'ium', 'esse'];
const WEAVES = ['Vinculum', 'Sigillum', 'Tessera', 'Textura', 'Lorica', 'Obligatio', 'Nexus'];
const VESSELS = ['Elixir', 'Essence', 'Tincture', 'Draught', 'Philter', 'Distillate', 'Decoction', 'Salve', 'Nectar', 'Infusion'];
const BODIES = ['Wyrm', 'Stag', 'Moth', 'Hound', 'Heron', 'Serpent', 'Owl', 'Fox', 'Raven', 'Leviathan', 'Salamander', 'Hare', 'Toad', 'Eel', 'Lynx', 'Mantis', 'Stoat', 'Crane', 'Beetle', 'Boar'];
const OBJECTS = ['Lantern', 'Mirror', 'Chalice', 'Compass', 'Locket', 'Spindle', 'Censer', 'Astrolabe', 'Hourglass', 'Bell', 'Orb', 'Signet', 'Gauntlet', 'Quill', 'Key', 'Mask', 'Thimble', 'Candelabrum', 'Loom', 'Sextant'];
const TOMES = ['Liber', 'Codex', 'Tractatus', 'Chronica', 'Commentarii', 'Speculum', 'Lexicon', 'Compendium', 'Annales', 'Epistulae'];
const PLACETYPES = ['Library', 'Spire', 'Orchard', 'Archway', 'Cistern', 'Observatory', 'Labyrinth', 'Crypt', 'Terrace', 'Hollow', 'Causeway', 'Vault', 'Grove', 'Cloister', 'Greenhouse'];
const RELICOBJ = ['Crown', 'Seal', 'Tooth', 'Mantle', 'Heart', 'Ring', 'Staff', 'Bone', 'Veil', 'Chain', 'Eye', 'Throne'];
const PLANTBODY = ['Bellflower', 'Thistle', 'Fern', 'Moss', 'Orchid', 'Lily', 'Vine', 'Mushroom', 'Rue', 'Reed', 'Lichen', 'Willow', 'Thornberry', 'Sedge', 'Clover'];
const FORBWORDS = ['Arcanum', 'Nefas', 'Occultum', 'Secretum', 'Vetitum', 'Abyssus', 'Sepulcrum'];
const RITEWORDS = ['Rite', 'Vigil', 'Procession', 'Communion', 'Unbinding', 'Offering', 'Convocation', 'Crossing', 'Naming'];

const LIB = new Map();
const BY_CAT = Object.fromEntries(Object.keys(CATS).map((c) => [c, []]));
const usedNames = new Set();
function addEntry(cat, name, desc, effect, attr, rarity = null) {
  const id = slugify(name);
  if (usedNames.has(name.toLowerCase()) || LIB.has(id)) return false;
  usedNames.add(name.toLowerCase());
  const item = { id, cat, name, desc, effect, attr, rarity };
  LIB.set(id, item);
  BY_CAT[cat].push(item);
  return true;
}

// Hand-written signature entries (two per category).
const CURATED = [
  ['spell', 'Caelum Fractum', 'Mythical', 'Splits the air above the caster into a seam of pale light. Scholars still argue over whether it opens a door or merely tears the sky.', 'Opens a seam that sends one hand-sized object to any place the caster has stood.', 'Casting: traced with the left hand · Cost: a day of the longest shadow'],
  ['spell', 'Susurrus Ultimus', 'Epic', 'The final whisper, taught to those who must leave a room without being noticed. It is said to work on everyone except the person who loves the caster most.', 'Erases the caster from the attention of a room for the length of one slow breath.', 'Casting: spoken against the palm · Cost: a borrowed name'],
  ['curse', 'Anathema Vacuum', 'Forbidden', 'Pronounced over a doorway to make it a boundary that no kindness can cross. The spell has outlived every household it was cast upon.', 'Prevents the target from receiving help, gifts or shelter from anyone who knows their name.', 'Lifted by: a debt repaid in full · Duration: until broken'],
  ['curse', 'The Hollow Lullaby', 'Rare', 'A cradle-song turned inside out and hummed by a rival until the listener cannot hold a thought for longer than a verse.', 'Cuts the target\'s attention to the span of a single song.', 'Lifted by: three nights of honest sleep · Duration: one moon'],
  ['charm', 'Candlewick Pardon', 'Uncommon', 'A small charm tucked into a pocket by those who expect to be scolded. It softens the first harsh word, but only the first.', 'Turns aside the first angry remark aimed at the bearer each day.', 'Lasts: one day · Range: touch'],
  ['charm', 'Lumenith', 'Epic', 'A charm shaped like a thumbprint of light pressed above a doorway. Households that keep it say the dark never quite settles in the corners.', 'Keeps a room faintly lit and free of lingering dread.', 'Lasts: until the next rain · Range: a doorway'],
  ['enchantment', 'Sigillum Sileo', 'Rare', 'Stitched into the hem of a cloak, it hushes the wearer\'s footsteps without muffling anything else, which is why couriers and thieves prize it equally.', 'Silences the wearer\'s footsteps.', 'Binds to: cloth · Endures: a year'],
  ['enchantment', 'Tessera Aeterna', 'Legendary', 'Every tile of a floor wrought with this enchantment remembers the weight of all who have crossed it, and answers only to the last.', 'A floor remembers every visitor and warns its keeper of any stranger.', 'Binds to: stone · Endures: a lifetime'],
  ['potion', 'Draught of Unspent Winters', 'Legendary', 'Brewed from frost gathered across seven nights and never allowed to see a flame. The drinker is said to feel, briefly, every winter they have yet to live.', 'Grants one perfect vision of the coming winter\'s hardest night.', 'Brew time: a full moon · Taste: cold iron'],
  ['potion', 'Tincture of Second Thoughts', 'Common', 'A pale, bitter draught prescribed to the impulsive. It does not change a mind, only the pace at which it is made up.', 'Delays any rash decision by a full minute of clear thinking.', 'Brew time: a single hour · Taste: bitter apple'],
  ['creature', 'Vesperine Stag', 'Mythical', 'A stag the colour of the sky an hour after sunset, with antlers that hold a small, steady constellation. It appears to travellers who are lost but not yet afraid.', 'Leads the lost along the safest path, then vanishes before dawn.', 'Habitat: high moorland · Temperament: shy · Taxon: Cervus vesperis'],
  ['creature', 'Inkmoth', 'Common', 'A palm-sized moth whose wings smear faint ink across whatever they brush. Archivists keep them away from manuscripts and, privately, in jars on their desks.', 'Leaves harmless ink trails that spell out words when disturbed by a draught.', 'Habitat: abandoned libraries · Temperament: curious · Taxon: Noctua scriptoris'],
  ['artifact', 'The Cartographer\'s Last Compass', 'Legendary', 'Its needle ignores north and points instead to whatever its holder has misplaced, forgotten or lost. It has never once been wrong, and never once been comforting.', 'Points to the nearest thing its holder has lost.', 'Wielded by: whoever finds it first · Weight: heavier than it looks'],
  ['artifact', 'Candlewax Seal of Ruen', 'Uncommon', 'A stamp whose impression can be seen only by the person a letter is meant for. To everyone else the wax stays smooth.', 'Makes a sealed letter unreadable to anyone but its intended recipient.', 'Wielded by: those who ask it politely · Weight: light as a feather'],
  ['book', 'Liber Ignotus', 'Epic', 'A volume whose title is the only page that stays the same from one reading to the next. Everything inside is relevant to the reader\'s present troubles, usually unpleasantly.', 'Opens to the passage the reader most needs, never the one they want.', 'Author: unknown · Pages: 412'],
  ['book', 'Almanac of Small Mercies', 'Uncommon', 'A battered and cheerful almanac listing the minor kindnesses due on each day of the year, from lost keys found to rain that holds off an hour.', 'Foretells one minor stroke of good luck each morning.', 'Author: Tess Brindane · Pages: 366'],
  ['location', 'The Observatory Beneath the Lake', 'Legendary', 'A domed chamber on the lakebed, dry inside, where the stars can be seen through the water on any night regardless of weather.', 'Shows the night sky as it will look on the visitor\'s last night in the region.', 'Found: behind a waterfall · Best visited: the dark of winter'],
  ['location', 'The Lantern Market of Ashmere', 'Rare', 'A market held only after dark, lit entirely by lanterns that are sold, never carried. Stallholders accept favours, secrets and, rarely, coin.', 'Visitors may trade a memory for an object, one object per night.', 'Found: at the end of a road missing from maps · Best visited: a new moon'],
  ['prophecy', 'The Prophecy of the Unfinished Bell', 'Epic', 'When the bell is cast and does not ring, the town will learn who has been listening at its doors.', 'Fulfilled when: a bell is hung without a clapper', 'Spoken by: the bellfounder\'s widow'],
  ['prophecy', 'The Eighth Candle', 'Rare', 'Seven candles burn on the table before the guest arrives. The eighth lights itself, and from that moment the house keeps no secrets.', 'Fulfilled when: a candle is found lit in an empty room', 'Spoken by: the ferryman Orrin'],
  ['relic', 'Crown of the Quiet Heir', 'Mythical', 'Worn once by a ruler who never gave a single order, and who is remembered as the wisest of their line. The crown is still warm when picked up.', 'Compels truthful speech from anyone who speaks while the bearer listens.', 'Once held by: the lamplighter Vaelis'],
  ['relic', 'Tooth of the Tide-Mother', 'Rare', 'A curved white tooth the length of a forearm, found on a beach that existed for one winter. Sailors who carry a shaving of it claim never to drown, only to be returned.', 'Washes the bearer ashore after any shipwreck.', 'Once held by: the ferryman Kelith'],
  ['plant', 'Moonwick Lily', 'Rare', 'A pale lily that blooms for an hour after moonrise, opening wider the more it hears of true things.', 'Opens only for honest speech, revealing whether a statement nearby was true.', 'Harvest: under a new moon · Grows: beside still water'],
  ['plant', 'Kettleweed', 'Common', 'A humble marsh weed that steams faintly whenever someone nearby is cold. Travellers love it and farmers curse it, since it will not stay in a field.', 'Warms the air around it in a gentle radius of three paces.', 'Harvest: before dawn · Grows: beside still water'],
  ['forbidden', 'Arcanum Nullum', 'Forbidden', 'The knowledge of how to unwrite a name from every record at once. Its keepers burned the only copy, and two memories of it remain.', 'Removes a chosen name from every written record within a day\'s ride.', 'Sealed by: a page torn from every copy · Known to: one exile'],
  ['forbidden', 'The Seventh Silence', 'Mythical', 'A lesson in the kind of quiet that follows the last word of a language. Those who study it are said to become hard to hear.', 'Hushes a single word from every mouth in a hall for one evening.', 'Sealed by: an oath of silence · Known to: no living scholar'],
  ['ritual', 'Vigil of the Borrowed Dawn', 'Epic', 'Held on the longest night, when participants each lend one hour of the next morning to someone who needs it more.', 'Shifts one hour of daylight toward the person most in need.', 'Participants: 7 · Hour: before the first bird'],
  ['ritual', 'Rite of the Open Hand', 'Common', 'A small gathering where each guest places an empty hand on the table and states one thing they no longer need. It is said to make the table lighter.', 'Eases a shared burden by a small, noticeable measure.', 'Participants: 3 · Hour: at sunset'],
];
for (const [cat, name, rarity, desc, effect, attr] of CURATED) addEntry(cat, name, desc, effect, attr, rarity);

const tn = () => { const t = pick(THEME_KEYS); return [t, pick(THEMES[t].adj), pick(THEMES[t].noun)]; };
const TARGETS = { spell: 85, curse: 65, charm: 65, enchantment: 65, potion: 90, creature: 100, artifact: 85, book: 75, location: 75, prophecy: 100, relic: 75, plant: 85, forbidden: 55, ritual: 65 };
const MAKERS = {
  spell() { const a = pick(LN), b = pick(LN); if (a === b) return null; return [`${a[0]} ${b[1]}`, dress(OR_ITEM, 'spell'), pick(THEMES[a[2]].boon), `Casting: ${pick(CASTING)} · Cost: ${pick(COST)}`]; },
  curse() { const a = pick(LN); return [`${pick(CURSEWORDS)} ${a[1]}`, dress(OR_ITEM, 'curse'), pick(THEMES[a[2]].bane), `Lifted by: ${pick(LIFTED)} · Duration: ${pick(DURATION)}`]; },
  charm() { const a = pick(LN); const name = capital(a[0].toLowerCase().slice(0, randInt(3, 5))) + pick(SUFFIX); return [name, dress(OR_ITEM, 'charm'), pick(THEMES[a[2]].boon), `Lasts: ${pick(LASTS)} · Range: ${pick(RANGE)}`]; },
  enchantment() { const a = pick(LN); return [`${pick(WEAVES)} ${a[1]}`, dress(OR_ITEM, 'enchantment'), pick(THEMES[a[2]].boon), `Binds to: ${pick(BINDS)} · Endures: ${pick(ENDURES)}`]; },
  potion() { const [t, adj, noun] = tn(); return [`${pick(VESSELS)} of ${adj} ${noun}`, dress(OR_ITEM, 'potion'), pick(THEMES[t].boon), `Brew time: ${pick(BREW)} · Taste: ${pick(TASTE)}`]; },
  creature() {
    const t = pick(THEME_KEYS); const a = pick(LN_T[t]), b = pick(LN_T[t]);
    const front = rng() < 0.5 ? pick(THEMES[t].adj) : pick(THEMES[t].noun);
    return [`${front} ${pick(BODIES)}`, dress(OR_BEING, 'creature'), pick(THEMES[t].lore), `Habitat: ${pick(HABITAT)} · Temperament: ${pick(TEMPER)} · Taxon: ${a[0]} ${b[1].toLowerCase()}`];
  },
  artifact() { const [t, adj] = tn(); return [`The ${adj} ${pick(OBJECTS)}`, dress(OR_ITEM, 'artifact'), pick(THEMES[t].boon), `Wielded by: ${pick(WIELDED)} · Weight: ${pick(WEIGHT)}`]; },
  book() { const a = pick(LN); return [`${pick(TOMES)} ${a[1]}`, dress(OR_ITEM, 'book'), pick(THEMES[a[2]].boon), `Author: ${fullName()} · Pages: ${randInt(40, 900)}`]; },
  location() { const [t, adj] = tn(); return [`The ${adj} ${pick(PLACETYPES)}`, dress(OR_PLACE, 'place'), pick(THEMES[t].boon), `Found: ${pick(FOUND)} · Best visited: ${pick(SEASON)}`]; },
  prophecy() {
    const [, adj1, noun1] = tn(); const [, adj2, noun2] = tn();
    return [`The Prophecy of the ${adj1} ${noun1}`, `When the ${adj2} ${noun2} ${pick(EVENTS)}, ${pick(CONSEQ)}.`, `Fulfilled when: ${pick(FULFIL)}`, `Spoken by: ${person()}`];
  },
  relic() { const [t, adj, noun] = tn(); return [`${pick(RELICOBJ)} of the ${adj} ${noun}`, dress(OR_ITEM, 'relic'), pick(THEMES[t].boon), `Once held by: ${person()}`]; },
  plant() { const [t, adj, noun] = tn(); const front = rng() < 0.5 ? adj : noun; return [`${front} ${pick(PLANTBODY)}`, dress(OR_BEING, 'plant'), pick(THEMES[t].boon), `Harvest: ${pick(HARVEST)} · Grows: ${pick(GROWS)}`]; },
  forbidden() { const a = pick(LN); return [`${pick(FORBWORDS)} ${a[1]}`, dress(OR_ITEM, 'knowledge'), pick(THEMES[a[2]].bane), `Sealed by: ${pick(SEALED)} · Known to: ${pick(KNOWN)}`]; },
  ritual() { const [t, adj, noun] = tn(); return [`${pick(RITEWORDS)} of the ${adj} ${noun}`, dress(OR_ITEM, 'rite'), pick(THEMES[t].boon), `Participants: ${randInt(1, 9)} · Hour: ${pick(HOURS)}`]; },
};
Object.keys(CATS).forEach((cat, idx) => {
  seedRng(0x5eed + idx * 7919);
  let guard = 0;
  while (BY_CAT[cat].length < TARGETS[cat] && guard++ < TARGETS[cat] * 100) {
    const made = MAKERS[cat]();
    if (made) addEntry(cat, ...made);
  }
});

// Rarity assignment: fixed quotas per category, so every rarity (including Forbidden) exists everywhere.
const QUOTA = [0.34, 0.26, 0.18, 0.10, 0.07, 0.04, 0.01];
const QUOTA_FORBIDDEN = [0, 0, 0.20, 0.25, 0.25, 0.18, 0.12];
Object.keys(CATS).forEach((cat, idx) => {
  seedRng(0xa11ce + idx * 104729);
  const items = BY_CAT[cat];
  const free = items.filter((i) => !i.rarity);
  const q = cat === 'forbidden' ? QUOTA_FORBIDDEN : QUOTA;
  const counts = q.map((w) => (w ? Math.max(1, Math.round(items.length * w)) : 0));
  for (const i of items) if (i.rarity) { const k = RARITIES.indexOf(i.rarity); if (counts[k] > 0) counts[k]--; }
  const pool = [];
  counts.forEach((n, k) => { for (let j = 0; j < n; j++) pool.push(RARITIES[k]); });
  while (pool.length < free.length) pool.push(RARITIES[q[0] ? 0 : 2]);
  while (pool.length > free.length) { const ci = pool.indexOf('Common'); pool.splice(ci >= 0 ? ci : 0, 1); }
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  free.forEach((item, k) => { item.rarity = pool[k]; });
});

// Index for weighted discovery: rarity is rolled first, then an entry is picked within that rarity.
const POOL = {};
for (const item of LIB.values()) {
  (POOL[`all|${item.rarity}`] ||= []).push(item);
  (POOL[`${item.cat}|${item.rarity}`] ||= []).push(item);
}

// Fortunes, visions and oracle answers.
const F_WHEN = ['Before the next new moon', 'By the time the candle burns low', 'Within three sunsets', 'When the next stranger greets you', 'Before the week turns', 'On the first clear night', 'When the wind changes quarter', 'Once the rain has passed', 'By the next market day', 'At the turning of the tide'];
const F_OMEN = ['a letter you had given up on will arrive', 'a closed door will be left ajar', 'an old debt will be forgiven without being mentioned', 'a quiet rival will offer an unexpected hand', 'something you lost will be returned by someone you barely know', 'a small kindness will reveal itself as a large one', 'a plan you abandoned will look wise again', 'a question you have carried will answer itself', 'a friend will say exactly what you needed to hear', 'a long silence will end', 'a risk you feared will turn out to be a bargain', 'an unfamiliar road will prove the shorter one', 'someone will remember your name when it matters', 'a trouble you dread will shrink to its true size'];
const F_ADVICE = ['Keep your answer short.', 'Say yes before you overthink it.', 'Carry a coin and a candle.', 'Do not repeat what you hear tonight.', 'Pay attention to the second thing, not the first.', 'Let the silence do some of the work.', 'Mend what is nearest before you chase what is far.', 'Trust the unhurried option.', 'Write it down before it fades.', 'Ask once more, more gently.', 'Leave a light on.', 'Wear the older coat.', 'Waiting costs less than you think.', 'Return what you borrowed.'];
const FORTUNES = [];
{
  seedRng(0xf0a7);
  const seen = new Set();
  let guard = 0;
  while (FORTUNES.length < 220 && guard++ < 5000) {
    const text = `${pick(F_WHEN)}, ${pick(F_OMEN)}. ${pick(F_ADVICE)}`;
    if (!seen.has(text)) { seen.add(text); FORTUNES.push(text); }
  }
}
const V_SCENE = ['a lit window in a house you have never visited', 'two hands sliding a key across a table', 'a path of wet stones leading into fog', 'a clock whose hands run in opposite directions', 'a long table with one chair pulled out', 'a bird circling a tower that has no door', 'a river carrying a single paper boat', 'a crowd parting for someone you cannot see', 'a lantern left burning on a windowsill', 'a staircase that descends into daylight', 'a closed book with your handwriting on its spine', 'a field of tall grass bending against the wind', 'a coin spinning that never falls', 'an open gate with nobody beyond it', 'a candle guttering in a draught that is not there', 'a mirror showing a different season'];
const V_MEAN = ['a decision is closer than it feels', 'someone is thinking of you more kindly than you know', 'an ending you expect will turn out to be a start', 'patience will serve you better than haste', 'a promise will soon be tested', 'the answer lies in the thing you keep avoiding', 'you are being waited for', 'a debt of attention is due', 'a small change will matter greatly', 'what looks like loss is only rearrangement', 'a stranger will prove to be an ally', 'you already hold what you are looking for', 'the quiet option is the wise one', 'a message is on its way', 'your second impression is the one to trust', 'a door will close so another can be heard'];
const ORACLE_VERDICT = ['The signs lean toward yes.', 'The omens are against it.', 'The answer is not yet written.', 'Yes, though not in the way you expect.', 'No, and that is kinder than it sounds.', 'It depends on what you do next.', 'Ask again after the next moonrise.', 'The Oracle sees it clearly: yes.', 'The Oracle sees it clearly: no.', 'It will happen, but late.', 'The way is open, yet narrow.', 'The question hides a better one.'];
const ORACLE_ADVICE = ['Act with care.', 'Speak little and listen much.', 'Wait three days before deciding.', 'Bring a witness.', 'Trust the older advice.', 'Do not rush the ending.', 'Look to what is already in your hands.', 'Be generous with the first step.', 'Keep the matter to yourself.', 'Settle what you owe first.'];
const hashString = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h >>> 0; };
const randomOf = (a) => a[Math.floor(Math.random() * a.length)];
function rollRarity() {
  let r = Math.random() * 100;
  for (let i = 0; i < RARITIES.length; i++) { r -= DROP_RATES[i]; if (r < 0) return RARITIES[i]; }
  return RARITIES[0];
}
function pickDiscovery(cat) {
  const scope = cat || 'all';
  // Re-roll until the rolled rarity exists in this scope, which keeps the odds proportional.
  for (let tries = 0; tries < 200; tries++) {
    const pool = POOL[`${scope}|${rollRarity()}`];
    if (pool && pool.length) return randomOf(pool);
  }
  return randomOf(BY_CAT[cat] || [...LIB.values()]);
}

/* ---------------------- 7b. DISCOVERY AND COLLECTIONS --------------------- */
const catLabel = (c) => CATS[c] || c;
const rarityColor = (r) => RARITY_COLOR[Math.max(0, RARITIES.indexOf(r))];
const CAT_CHOICES = [...Object.keys(CATS), 'fortune'];

function itemEmbed(item, footer) {
  const isProphecy = item.cat === 'prophecy';
  return new EmbedBuilder().setColor(rarityColor(item.rarity)).setTitle(item.name).setDescription(item.desc)
    .addFields(
      { name: 'Category', value: catLabel(item.cat), inline: true },
      { name: 'Rarity', value: item.rarity, inline: true },
      { name: isProphecy ? 'Fulfilment' : 'Effect', value: isProphecy ? capital(item.effect.replace(/^Fulfilled when: /, '')) : item.effect },
      { name: 'Details', value: item.attr },
    )
    .setFooter({ text: `${FOOTER} · ${footer}` });
}

const stUpsert = db.prepare(
  `INSERT INTO collection (guild_id, user_id, item_id, cat, name, rarity, qty, first_at, last_at)
   VALUES (?,?,?,?,?,?,1,?,?)
   ON CONFLICT (guild_id, user_id, item_id) DO UPDATE SET qty = qty + 1, last_at = excluded.last_at
   RETURNING qty`
);
const stHistory = db.prepare(
  'INSERT INTO discovery_history (guild_id, user_id, item_id, name, cat, rarity, at, duplicate) VALUES (?,?,?,?,?,?,?,?)'
);
function recordDiscovery(guildId, userId, item) {
  return db.transaction(() => {
    const now = Date.now();
    const { qty } = stUpsert.get(guildId, userId, item.id, item.cat, item.name, item.rarity, now, now);
    stHistory.run(guildId, userId, item.id, item.name, item.cat, item.rarity, now, qty > 1 ? 1 : 0);
    const { n } = db.prepare('SELECT COUNT(*) n FROM collection WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
    return { qty, unique: n };
  })();
}

const discoverCooldown = new Map();
function checkCooldown(userId) {
  const now = Date.now();
  const wait = 5000 - (now - (discoverCooldown.get(userId) || 0));
  if (wait > 0) throw new UserError(`Give the air a moment to settle. Try again in ${Math.ceil(wait / 1000)}s.`);
  discoverCooldown.set(userId, now);
  if (discoverCooldown.size > 5000) for (const [k, v] of discoverCooldown) if (now - v > 60000) discoverCooldown.delete(k);
}
const againRow = (userId, cat) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`da:${userId}:${cat || 'any'}`).setLabel('Discover again').setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId(`dc:${userId}`).setLabel('My collection').setStyle(ButtonStyle.Secondary),
);
function discoverPayload(guildId, userId, cat) {
  checkCooldown(userId);
  const item = pickDiscovery(cat);
  const rec = recordDiscovery(guildId, userId, item);
  const note = rec.qty > 1 ? `Duplicate · you now hold ${rec.qty}` : `New discovery · ${rec.unique} in your collection`;
  return { embeds: [itemEmbed(item, note)], components: [againRow(userId, cat)] };
}
function fortunePayload(cfg, userId) {
  checkCooldown(userId);
  return { embeds: [embed(cfg, randomOf(FORTUNES)).setTitle('Fortune')], components: [againRow(userId, 'fortune')] };
}
const discoverRun = (ctx, cat) => ctx.reply(cat === 'fortune'
  ? fortunePayload(ctx.cfg, ctx.user.id)
  : discoverPayload(ctx.guild.id, ctx.user.id, cat || null));

define({
  name: 'discover', description: 'Discover something from the magical archives', category: 'Discovery',
  options: [opt('string', 'category', 'What to discover (random if omitted)', false, { choices: CAT_CHOICES })],
  run: (ctx, a) => discoverRun(ctx, a.category),
});
for (const [name, cat, description] of [
  ['spell', 'spell', 'Discover a random spell'], ['potion', 'potion', 'Discover a random potion'],
  ['summon', 'creature', 'Summon a magical creature'], ['prophecy', 'prophecy', 'Receive a mysterious prophecy'],
  ['fortune', 'fortune', 'Receive a magical fortune'],
]) define({ name, description, category: 'Magic', run: (ctx) => discoverRun(ctx, cat) });

define({
  name: 'crystalball', description: 'Gaze into the crystal ball', category: 'Magic',
  async run(ctx) {
    await ctx.reply({ embeds: [embed(ctx.cfg, `The glass clouds, then clears. You see ${randomOf(V_SCENE)}.\n\nIt suggests that ${randomOf(V_MEAN)}.`).setTitle('Crystal ball')] });
  },
});
define({
  name: 'oracle', description: 'Ask the Oracle a question', category: 'Magic',
  options: [opt('string', 'question', 'Your question', true, { rest: true, maxLength: 300 })],
  async run(ctx, a) {
    // The same question from the same person gets the same answer for the rest of the day.
    const r = mulberry32(hashString(`${a.question.toLowerCase().trim()}|${ctx.user.id}|${Math.floor(Date.now() / 864e5)}`));
    const verdict = ORACLE_VERDICT[Math.floor(r() * ORACLE_VERDICT.length)];
    const advice = ORACLE_ADVICE[Math.floor(r() * ORACLE_ADVICE.length)];
    await ctx.reply({ embeds: [embed(ctx.cfg, `*${clip(a.question, 250)}*\n\n${verdict} ${advice}`).setTitle('The Oracle')] });
  },
});

// Collection and codex browsers. All state lives in the component ids, so panels keep working after restarts.
const PAGE_SIZE = 8;
const SORT_LABEL = { c: { n: 'Newest first', x: 'Rarest first' }, x: { n: 'A to Z', x: 'Rarest first' } };
const browseId = (kind, st, over = {}) => {
  const s = { ...st, ...over };
  return [kind, s.mode, s.viewer, s.target, s.cat, s.page, s.sort].join(':');
};
async function renderBrowser(st) {
  const codex = st.mode === 'x';
  let entries;
  if (codex) {
    const mine = new Set(db.prepare('SELECT item_id FROM collection WHERE guild_id = ? AND user_id = ? AND cat = ?')
      .all(st.guildId, st.viewer, st.cat).map((r) => r.item_id));
    entries = BY_CAT[st.cat].map((i) => ({ id: i.id, name: i.name, rarity: i.rarity, cat: i.cat, found: mine.has(i.id) }));
  } else {
    const rows = st.cat === 'all'
      ? db.prepare('SELECT * FROM collection WHERE guild_id = ? AND user_id = ?').all(st.guildId, st.target)
      : db.prepare('SELECT * FROM collection WHERE guild_id = ? AND user_id = ? AND cat = ?').all(st.guildId, st.target, st.cat);
    entries = rows.map((r) => ({ id: r.item_id, name: r.name, rarity: r.rarity, cat: r.cat, qty: r.qty, at: r.last_at }));
  }
  const rank = (r) => RARITIES.indexOf(r);
  if (st.sort === 'x') entries.sort((a, b) => rank(b.rarity) - rank(a.rarity) || a.name.localeCompare(b.name));
  else if (codex) entries.sort((a, b) => a.name.localeCompare(b.name));
  else entries.sort((a, b) => b.at - a.at);
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, st.page), pages - 1);
  const slice = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const cur = { ...st, page };

  const e = embed(getConfig(st.guildId)).setFooter({ text: `${FOOTER} · Page ${page + 1} of ${pages}` });
  if (codex) {
    const found = entries.filter((x) => x.found).length;
    e.setTitle(`Codex · ${catLabel(st.cat)}`);
    e.setDescription(`${found} of ${entries.length} discovered by you. Pick an entry below to read it.\n\n` +
      slice.map((x) => `**${x.name}** · ${x.rarity}${x.found ? ' · found' : ''}`).join('\n'));
  } else {
    const user = await client.users.fetch(st.target).catch(() => null);
    const total = st.cat === 'all' ? LIB.size : BY_CAT[st.cat].length;
    e.setTitle(`${user ? user.username : 'Member'}'s ${st.cat === 'all' ? 'collection' : catLabel(st.cat).toLowerCase()}`);
    e.setDescription(entries.length
      ? `${entries.length} of ${total} discovered.\n\n` + slice.map((x) => `**${x.name}** · ${x.rarity}${x.qty > 1 ? ` · x${x.qty}` : ''}`).join('\n')
      : 'Nothing here yet. Use `/discover` to begin.');
    if (st.cat === 'all' && entries.length) {
      const by = RARITIES.map((r) => [r, entries.filter((x) => x.rarity === r).length]).filter(([, n]) => n);
      e.addFields({ name: 'By rarity', value: by.map(([r, n]) => `${r} ${n}`).join(' · ') });
    }
  }

  const catMenu = new StringSelectMenuBuilder().setCustomId(browseId('bs', cur)).setPlaceholder('Choose a category')
    .addOptions([...(codex ? [] : ['all']), ...Object.keys(CATS)].map((c) => ({
      label: c === 'all' ? 'All categories' : CATS[c], value: c, default: c === st.cat,
    })));
  const rows = [new ActionRowBuilder().addComponents(catMenu)];
  if (slice.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(browseId('be', cur))
      .setPlaceholder('Read an entry').addOptions(slice.map((x) => ({
        label: clip(x.name, 100), description: `${x.rarity} · ${catLabel(x.cat)}`, value: x.id,
      })))));
  }
  const flip = st.sort === 'x' ? 'n' : 'x';
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(browseId('bpp', cur, { page: Math.max(0, page - 1) })).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`noop:${page}`).setLabel(`${page + 1}/${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(browseId('bpn', cur, { page: Math.min(pages - 1, page + 1) })).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    new ButtonBuilder().setCustomId(browseId('bps', cur, { page: 0, sort: flip })).setLabel(SORT_LABEL[st.mode][st.sort]).setStyle(ButtonStyle.Primary),
  ));
  return { embeds: [e], components: rows };
}
function detailPayload(st, itemId) {
  const owner = st.mode === 'x' ? st.viewer : st.target;
  const row = db.prepare('SELECT * FROM collection WHERE guild_id = ? AND user_id = ? AND item_id = ?').get(st.guildId, owner, itemId);
  const lib = LIB.get(itemId);
  let e;
  if (lib && !row) {
    e = new EmbedBuilder().setColor(rarityColor(lib.rarity)).setTitle(lib.name)
      .setDescription('You have not discovered this entry yet. Its description stays hidden until you find it.')
      .addFields({ name: 'Category', value: catLabel(lib.cat), inline: true }, { name: 'Rarity', value: lib.rarity, inline: true })
      .setFooter({ text: `${FOOTER} · Undiscovered` });
  } else {
    const item = lib || { cat: row.cat, name: row.name, rarity: row.rarity, desc: 'This entry has since been retired from the archives.', effect: 'None recorded.', attr: 'None recorded.' };
    e = itemEmbed(item, row ? `Discovered ${row.qty > 1 ? `${row.qty} times` : 'once'}` : 'Archive entry');
  }
  const back = new ButtonBuilder().setCustomId(browseId('bb', st)).setLabel('Back').setStyle(ButtonStyle.Secondary);
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(back)] };
}
const startBrowser = async (ctx, mode, cat, target) => ctx.reply(await renderBrowser({
  guildId: ctx.guild.id, mode, viewer: ctx.user.id, target: target.id, cat, page: 0, sort: 'n',
}));
define({
  name: 'collection', description: 'View your discoveries (or another member\'s)', category: 'Discovery',
  options: [opt('user', 'member', 'Member (defaults to you)')],
  run: (ctx, a) => startBrowser(ctx, 'c', 'all', a.member || ctx.user),
});
define({
  name: 'spellbook', description: 'Browse the spells you have discovered', category: 'Discovery',
  options: [opt('user', 'member', 'Member (defaults to you)')],
  run: (ctx, a) => startBrowser(ctx, 'c', 'spell', a.member || ctx.user),
});
define({
  name: 'codex', description: 'Browse the magical encyclopedia', category: 'Discovery',
  options: [opt('string', 'category', 'Category (defaults to spells)', false, { choices: Object.keys(CATS) })],
  run: (ctx, a) => startBrowser(ctx, 'x', a.category || 'spell', ctx.user),
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.guild || !(i.isButton() || i.isStringSelectMenu())) return;
  const parts = i.customId.split(':');
  const kind = parts[0];
  if (!['bs', 'be', 'bb', 'bpp', 'bpn', 'bps', 'da', 'dc'].includes(kind)) return;
  try {
    const owner = kind === 'da' || kind === 'dc' ? parts[1] : parts[2];
    if (i.user.id !== owner) {
      return await i.reply({ embeds: [failEmbed('This panel belongs to someone else. Run the command yourself to get your own.')], flags: MessageFlags.Ephemeral });
    }
    if (kind === 'da') {
      const cat = parts[2];
      if (cat !== 'any' && cat !== 'fortune' && !CATS[cat]) return;
      return await i.reply(cat === 'fortune' ? fortunePayload(getConfig(i.guild.id), i.user.id)
        : discoverPayload(i.guild.id, i.user.id, cat === 'any' ? null : cat));
    }
    if (kind === 'dc') {
      const st = { guildId: i.guild.id, mode: 'c', viewer: i.user.id, target: i.user.id, cat: 'all', page: 0, sort: 'n' };
      return await i.reply({ ...(await renderBrowser(st)), flags: MessageFlags.Ephemeral });
    }
    const st = {
      guildId: i.guild.id, mode: parts[1] === 'x' ? 'x' : 'c', viewer: parts[2], target: parts[3],
      cat: parts[4], page: parseInt(parts[5], 10) || 0, sort: parts[6] === 'x' ? 'x' : 'n',
    };
    if (st.cat !== 'all' && !CATS[st.cat]) st.cat = st.mode === 'x' ? 'spell' : 'all';
    if (st.mode === 'x' && st.cat === 'all') st.cat = 'spell';
    if (kind === 'bs') {
      st.cat = i.values[0];
      st.page = 0;
      if (st.cat !== 'all' && !CATS[st.cat]) return;
      return await i.update(await renderBrowser(st));
    }
    if (kind === 'be') return await i.update(detailPayload(st, i.values[0]));
    return await i.update(await renderBrowser(st)); // bb, bpp, bpn, bps
  } catch (err) {
    if (!(err instanceof UserError)) console.error('Component error:', err);
    const body = { embeds: [failEmbed(err instanceof UserError ? err.message : 'That did not work. The error has been logged.')], flags: MessageFlags.Ephemeral };
    (i.replied || i.deferred ? i.followUp(body) : i.reply(body)).catch(() => {});
  }
});


/* ------------------------------- 8. EVENTS -------------------------------- */
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = commands.map(buildSlash);
  const route = process.env.DEV_GUILD_ID
    ? Routes.applicationGuildCommands(client.user.id, process.env.DEV_GUILD_ID)
    : Routes.applicationCommands(client.user.id);
  await rest.put(route, { body });
  console.log(`Registered ${body.length} slash commands${process.env.DEV_GUILD_ID ? ' to the dev guild' : ' globally'}.`);
}

// Expire temporary bans and timeouts.
async function sweepExpired() {
  const rows = db.prepare("SELECT * FROM cases WHERE active=1 AND expires_at IS NOT NULL AND expires_at <= ? AND type IN ('tempban','mute')").all(Date.now());
  for (const r of rows) {
    if (r.type === 'tempban') {
      const g = client.guilds.cache.get(r.guild_id);
      if (!g) continue;
      await g.bans.remove(r.user_id, 'Temporary ban expired').catch(() => {});
      createCase(g, 'unban', r.user_id, client.user.id, `Temporary ban from case #${r.num} expired`);
    }
    db.prepare('UPDATE cases SET active = 0 WHERE id = ?').run(r.id);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch (e) { console.error('Slash registration failed:', e); }
  setInterval(() => sweepExpired().catch((e) => console.error('Expiry sweep failed:', e)), 30e3);
  sweepExpired().catch(() => {});
});
client.on(Events.GuildCreate, (g) => getConfig(g.id));

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = lookup.get(interaction.commandName);
  if (!cmd || !interaction.guild) return;
  const sub = cmd.subs ? interaction.options.getSubcommand() : null;
  const ctx = new Ctx({ interaction, cmd, sub, cfg: getConfig(interaction.guild.id) });
  try {
    ctx.args = slashArgs(interaction, (sub ? cmd.subs[sub] : cmd).options || []);
    await execute(ctx);
  } catch (err) { await handleError(ctx, err); }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const cfg = getConfig(message.guild.id);
  if (!message.content.startsWith(cfg.prefix)) return;
  const tokens = message.content.slice(cfg.prefix.length).trim().split(/\s+/);
  const cmd = lookup.get((tokens.shift() || '').toLowerCase());
  if (!cmd) return;
  if (!message.member) message.member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!message.member) return;
  let sub = null;
  const ctx = new Ctx({ message, cmd, cfg });
  try {
    if (cmd.subs) {
      sub = (tokens.shift() || '').toLowerCase();
      if (!cmd.subs[sub]) throw new UserError(`Use one of: ${Object.keys(cmd.subs).map((s) => `\`${cfg.prefix}${cmd.name} ${s}\``).join(', ')}`);
      ctx.sub = sub;
    }
    ctx.args = await prefixArgs(sub ? cmd.subs[sub] : cmd, tokens, message.guild, usageOf(cfg.prefix, cmd, sub));
    await execute(ctx);
  } catch (err) { await handleError(ctx, err); }
});

client.on(Events.Error, (e) => console.error('Client error:', e));
client.on(Events.ShardError, (e) => console.error('Shard error:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));
process.on('SIGTERM', () => { client.destroy(); db.close(); process.exit(0); });

console.log('Starting Wands of Fate...');
console.log(`Database folder: ${dataDir}`);
console.log(`Loaded ${LIB.size} magical entries and ${commands.length} commands.`);
client.login(TOKEN).catch((err) => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
