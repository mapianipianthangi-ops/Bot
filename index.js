'use strict';
/* ==========================================================================
   WANDS OF FATE
   Stage 1: core framework, database + migrations, server config,
            unified slash/prefix command layer, moderation system.
   Stage 2: magical content library, discovery, collections, codex.
   Stage 3: /setup panels (welcome, goodbye, autorole, rules, logs), custom applications, new /help.
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
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField,
  AttachmentBuilder, Partials,
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
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
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
  // Stage 3: setup panels and custom applications
  `CREATE TABLE settings (
     guild_id TEXT NOT NULL,
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (guild_id, key)
   );
   CREATE TABLE applications (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     name TEXT NOT NULL COLLATE NOCASE,
     description TEXT NOT NULL DEFAULT '',
     review_channel TEXT,
     reviewer_role TEXT,
     panel_channel TEXT,
     panel_message TEXT,
     max_pending INTEGER NOT NULL DEFAULT 1,
     accept_msg TEXT NOT NULL DEFAULT '',
     reject_msg TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     UNIQUE (guild_id, name)
   );
   CREATE TABLE application_questions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     app_id INTEGER NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     label TEXT NOT NULL,
     style TEXT NOT NULL DEFAULT 'short',
     required INTEGER NOT NULL DEFAULT 1
   );
   CREATE INDEX idx_appq ON application_questions (app_id, position);
   CREATE TABLE application_submissions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     app_id INTEGER NOT NULL,
     app_name TEXT NOT NULL,
     user_id TEXT NOT NULL,
     answers TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     channel_id TEXT,
     message_id TEXT,
     reviewer_id TEXT,
     note TEXT,
     created_at INTEGER NOT NULL,
     reviewed_at INTEGER
   );
   CREATE INDEX idx_sub_user ON application_submissions (guild_id, user_id, app_id, status);`,
  // Stage 4: tickets
  `CREATE TABLE ticket_categories (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     name TEXT NOT NULL COLLATE NOCASE,
     description TEXT NOT NULL DEFAULT '',
     support_role TEXT,
     parent_channel TEXT,
     max_open INTEGER NOT NULL DEFAULT 1,
     welcome_msg TEXT NOT NULL DEFAULT '',
     close_msg TEXT NOT NULL DEFAULT '',
     questions TEXT NOT NULL DEFAULT '[]',
     UNIQUE (guild_id, name)
   );
   CREATE TABLE tickets (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     num INTEGER NOT NULL,
     category_id INTEGER,
     category_name TEXT NOT NULL,
     user_id TEXT NOT NULL,
     channel_id TEXT,
     status TEXT NOT NULL DEFAULT 'open',
     claimed_by TEXT,
     answers TEXT NOT NULL DEFAULT '[]',
     transcript TEXT,
     created_at INTEGER NOT NULL,
     closed_at INTEGER,
     closed_by TEXT,
     UNIQUE (guild_id, num)
   );
   CREATE INDEX idx_tickets_channel ON tickets (channel_id);
   CREATE INDEX idx_tickets_user ON tickets (guild_id, user_id, category_id, status);
   CREATE TABLE ticket_blacklist (
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     reason TEXT NOT NULL DEFAULT '',
     at INTEGER NOT NULL,
     PRIMARY KEY (guild_id, user_id)
   );`,
  // Stage 4: staff
  `CREATE TABLE staff_records (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     type TEXT NOT NULL,
     detail TEXT NOT NULL,
     by_id TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX idx_staff_records ON staff_records (guild_id, user_id, at);
   CREATE TABLE staff_activity (
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     day TEXT NOT NULL,
     msgs INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (guild_id, user_id, day)
   );
   CREATE TABLE leaves (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     reason TEXT NOT NULL,
     end_at INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     reviewer_id TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_leaves ON leaves (status, end_at);
   CREATE TABLE reports (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     reporter_id TEXT NOT NULL,
     target_id TEXT,
     reason TEXT NOT NULL,
     anonymous INTEGER NOT NULL DEFAULT 0,
     channel_id TEXT,
     message_id TEXT,
     created_at INTEGER NOT NULL
   );`,
  // Stage 4: giveaways, events, trivia
  `CREATE TABLE giveaways (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     message_id TEXT,
     prize TEXT NOT NULL,
     winners INTEGER NOT NULL DEFAULT 1,
     ends_at INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'active',
     host_id TEXT NOT NULL,
     req_role TEXT,
     winner_ids TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_giveaways ON giveaways (status, ends_at);
   CREATE TABLE giveaway_entries (
     giveaway_id INTEGER NOT NULL,
     user_id TEXT NOT NULL,
     PRIMARY KEY (giveaway_id, user_id)
   );
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL DEFAULT 'event',
     starts_at INTEGER NOT NULL,
     channel_id TEXT NOT NULL,
     message_id TEXT,
     status TEXT NOT NULL DEFAULT 'scheduled',
     reminded INTEGER NOT NULL DEFAULT 0,
     creator_id TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_events ON events (status, starts_at);
   CREATE TABLE event_joins (
     event_id INTEGER NOT NULL,
     user_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (event_id, user_id)
   );
   CREATE TABLE trivia_bank (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     question TEXT NOT NULL,
     answer TEXT NOT NULL,
     alts TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX idx_trivia_bank ON trivia_bank (guild_id);
   CREATE TABLE trivia_scores (
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     points INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (guild_id, user_id)
   );`,
  // Stage 4: community
  `CREATE TABLE anon_posts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     user_id TEXT NOT NULL,
     content TEXT NOT NULL,
     message_id TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE suggestions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     content TEXT NOT NULL,
     channel_id TEXT,
     message_id TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     note TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   );
   CREATE TABLE suggestion_votes (
     suggestion_id INTEGER NOT NULL,
     user_id TEXT NOT NULL,
     vote INTEGER NOT NULL,
     PRIMARY KEY (suggestion_id, user_id)
   );
   CREATE TABLE polls (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     message_id TEXT,
     question TEXT NOT NULL,
     options TEXT NOT NULL,
     ends_at INTEGER,
     status TEXT NOT NULL DEFAULT 'open',
     kind TEXT NOT NULL DEFAULT 'poll',
     creator_id TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_polls ON polls (status, ends_at);
   CREATE TABLE poll_votes (
     poll_id INTEGER NOT NULL,
     user_id TEXT NOT NULL,
     choice INTEGER NOT NULL,
     PRIMARY KEY (poll_id, user_id)
   );
   CREATE TABLE prompts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     text TEXT NOT NULL
   );
   CREATE INDEX idx_prompts ON prompts (guild_id, kind);
   CREATE TABLE awards (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     title TEXT NOT NULL,
     reason TEXT NOT NULL DEFAULT '',
     by_id TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX idx_awards ON awards (guild_id, user_id);
   CREATE TABLE motm (
     guild_id TEXT NOT NULL,
     month TEXT NOT NULL,
     user_id TEXT NOT NULL,
     reason TEXT NOT NULL DEFAULT '',
     by_id TEXT NOT NULL,
     PRIMARY KEY (guild_id, month)
   );
   CREATE TABLE birthdays (
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     day INTEGER NOT NULL,
     month INTEGER NOT NULL,
     PRIMARY KEY (guild_id, user_id)
   );
   CREATE INDEX idx_birthdays ON birthdays (guild_id, month, day);
   CREATE TABLE activity (
     guild_id TEXT NOT NULL,
     day TEXT NOT NULL,
     msgs INTEGER NOT NULL DEFAULT 0,
     joins INTEGER NOT NULL DEFAULT 0,
     leaves INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (guild_id, day)
   );
   CREATE TABLE verifications (
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (guild_id, user_id)
   );`,
  // Stage 4: role menus
  `CREATE TABLE role_menus (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL,
     channel_id TEXT,
     message_id TEXT,
     roles TEXT NOT NULL DEFAULT '[]'
   );
   CREATE INDEX idx_role_menus ON role_menus (guild_id);
   CREATE INDEX idx_role_menus_msg ON role_menus (message_id);`,
  // Stage 4: fun and custom content
  `CREATE TABLE daily_claims (
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     last_day TEXT NOT NULL,
     streak INTEGER NOT NULL DEFAULT 1,
     total INTEGER NOT NULL DEFAULT 1,
     PRIMARY KEY (guild_id, user_id)
   );
   CREATE TABLE duel_stats (
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     wins INTEGER NOT NULL DEFAULT 0,
     losses INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (guild_id, user_id)
   );
   CREATE TABLE house_members (
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     house INTEGER NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (guild_id, user_id)
   );
   CREATE TABLE custom_content (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     cat TEXT NOT NULL,
     name TEXT NOT NULL COLLATE NOCASE,
     rarity TEXT NOT NULL,
     description TEXT NOT NULL,
     effect TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (guild_id, name)
   );`,
  // Stage 5: shop
  `ALTER TABLE collection ADD COLUMN spent INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE shop_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     name TEXT NOT NULL COLLATE NOCASE,
     description TEXT NOT NULL DEFAULT '',
     stock INTEGER,
     per_member INTEGER NOT NULL DEFAULT 1,
     role_id TEXT,
     needs_staff INTEGER NOT NULL DEFAULT 0,
     tribute TEXT NOT NULL DEFAULT '[]',
     listed INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     UNIQUE (guild_id, name)
   );
   CREATE TABLE shop_orders (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     item_id INTEGER,
     item_name TEXT NOT NULL,
     user_id TEXT NOT NULL,
     offered TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'complete',
     channel_id TEXT,
     message_id TEXT,
     handled_by TEXT,
     note TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_shop_orders ON shop_orders (guild_id, user_id, item_id, status);`,
  // Stage 6: coins, afk, vault, duels, shop prices
  `CREATE TABLE wallets (
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     coins INTEGER NOT NULL DEFAULT 0,
     earned INTEGER NOT NULL DEFAULT 0,
     last_msg INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (guild_id, user_id)
   );
   CREATE TABLE afk (
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     reason TEXT NOT NULL DEFAULT '',
     since INTEGER NOT NULL,
     PRIMARY KEY (guild_id, user_id)
   );
   CREATE TABLE vault_claims (
     guild_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     last_day TEXT NOT NULL,
     PRIMARY KEY (guild_id, user_id)
   );
   CREATE TABLE duels (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     message_id TEXT,
     p1 TEXT NOT NULL,
     p2 TEXT NOT NULL,
     hp1 INTEGER NOT NULL DEFAULT 100,
     hp2 INTEGER NOT NULL DEFAULT 100,
     turn INTEGER NOT NULL DEFAULT 1,
     used1 TEXT NOT NULL DEFAULT '[]',
     used2 TEXT NOT NULL DEFAULT '[]',
     misses1 INTEGER NOT NULL DEFAULT 0,
     misses2 INTEGER NOT NULL DEFAULT 0,
     log TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'active',
     winner TEXT,
     deadline INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_duels ON duels (status, deadline);
   ALTER TABLE shop_items ADD COLUMN price INTEGER;
   ALTER TABLE shop_items ADD COLUMN rank_only INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE shop_orders ADD COLUMN paid INTEGER NOT NULL DEFAULT 0;`,
  // Multiple ticket panels (up to 10 per server)
  `CREATE TABLE ticket_panels (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT NOT NULL,
     name TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT 'Open a ticket',
     description TEXT NOT NULL DEFAULT 'Pick the category that fits and a private channel will be created for you and the staff.',
     style TEXT NOT NULL DEFAULT 'menu',
     categories TEXT NOT NULL DEFAULT '[]',
     channel_id TEXT,
     message_id TEXT
   );
   CREATE INDEX idx_ticket_panels ON ticket_panels (guild_id);`,
  // Several support roles per ticket category
  `ALTER TABLE ticket_categories ADD COLUMN support_roles TEXT NOT NULL DEFAULT '[]';`,
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
    features: {
      description: 'Show the status of every feature',
      async run(ctx) { await ctx.reply({ embeds: [embed(ctx.cfg, Object.keys(FEATURES).map((k) => `**${capital(k)}** · ${setupStatus(ctx.guild.id, k)}`).join('\n')).setTitle('Features').setFooter({ text: `${FOOTER} · Change any of these with /setup` })] }); },
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
function checkCooldown(userId, secs = 5) {
  const now = Date.now();
  const wait = secs * 1000 - (now - (discoverCooldown.get(userId) || 0));
  if (wait > 0) throw new UserError(`Give the air a moment to settle. Try again in ${Math.ceil(wait / 1000)}s.`);
  discoverCooldown.set(userId, now);
  if (discoverCooldown.size > 5000) for (const [k, v] of discoverCooldown) if (now - v > 60000) discoverCooldown.delete(k);
}
const againRow = (userId, cat) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`da:${userId}:${cat || 'any'}`).setLabel('Discover again').setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId(`dc:${userId}`).setLabel('My collection').setStyle(ButtonStyle.Secondary),
);
function discoverPayload(guildId, userId, cat, member) {
  const ms = getSetting(guildId, 'magic', {});
  if (ms.enabled === false) throw new UserError('Discovery is switched off in this server.');
  const pk = perksOf(guildId, member);
  checkCooldown(userId, pk && pk.cooldown !== undefined ? pk.cooldown : (ms.cooldown === undefined ? 30 : ms.cooldown));
  const item = pickLucky(guildId, cat, pk ? pk.luck : 0, pk ? pk.min : 0);
  const rec = recordDiscovery(guildId, userId, item);
  const gain = rec.qty === 1 ? earn(guildId, member, econ(guildId).discovery_coins || 0) : 0;
  const note = (rec.qty > 1 ? `Duplicate · you now hold ${rec.qty}` : `New discovery · ${rec.unique} in your collection`) + (gain ? ` · +${gain} ${coinName(guildId)}` : '');
  return { embeds: [itemEmbed(item, note)], components: [againRow(userId, cat)] };
}
function fortunePayload(cfg, userId) {
  checkCooldown(userId);
  return { embeds: [embed(cfg, randomOf(FORTUNES)).setTitle('Fortune')], components: [againRow(userId, 'fortune')] };
}
const discoverRun = (ctx, cat) => ctx.reply(cat === 'fortune'
  ? fortunePayload(ctx.cfg, ctx.user.id)
  : discoverPayload(ctx.guild.id, ctx.user.id, cat || null, ctx.member));

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
    entries = [...BY_CAT[st.cat], ...customItems(st.guildId).filter((x) => x.cat === st.cat)].map((i) => ({ id: i.id, name: i.name, rarity: i.rarity, cat: i.cat, found: mine.has(i.id) }));
  } else {
    const rows = st.cat === 'all'
      ? db.prepare('SELECT * FROM collection WHERE guild_id = ? AND user_id = ?').all(st.guildId, st.target)
      : db.prepare('SELECT * FROM collection WHERE guild_id = ? AND user_id = ? AND cat = ?').all(st.guildId, st.target, st.cat);
    entries = rows.map((r) => ({ id: r.item_id, name: r.name, rarity: r.rarity, cat: r.cat, qty: r.qty, spent: r.spent || 0, at: r.last_at }));
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
    const total = (st.cat === 'all' ? LIB.size : BY_CAT[st.cat].length) + customItems(st.guildId).filter((x) => st.cat === 'all' || x.cat === st.cat).length;
    e.setTitle(`${user ? user.username : 'Member'}'s ${st.cat === 'all' ? 'collection' : catLabel(st.cat).toLowerCase()}`);
    e.setDescription(entries.length
      ? `${entries.length} of ${total} discovered.\n\n` + slice.map((x) => `**${x.name}** · ${x.rarity}${x.qty > 1 ? ` · x${x.qty}` : ''}${x.spent ? ` · ${x.spent} offered` : ''}`).join('\n')
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
  const lib = LIB.get(itemId) || customItem(st.guildId, itemId);
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
        : discoverPayload(i.guild.id, i.user.id, cat === 'any' ? null : cat, i.member));
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



/* ----------------------------- 7c. SETUP PANELS --------------------------- */
// Nothing here ships with default content. Every feature starts empty and is configured by the server.
const getSetting = (gid, key, def = null) => {
  const r = db.prepare('SELECT value FROM settings WHERE guild_id = ? AND key = ?').get(gid, key);
  if (!r) return def;
  try { return JSON.parse(r.value); } catch { return def; }
};
const putSetting = (gid, key, val) => db.prepare(
  'INSERT INTO settings (guild_id, key, value) VALUES (?,?,?) ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value'
).run(gid, key, JSON.stringify(val));

const FEATURES = {
  welcome: 'Greet new members in a channel of your choice',
  goodbye: 'Post a message when members leave',
  autorole: 'Give roles to members as they join',
  rules: 'Write the server rules and post them',
  applications: 'Build your own applications and review them',
  logs: 'Choose where moderation logs are sent',
};
const FEATURE_LIST = Object.keys(FEATURES);
const SETUP = {};
function registerFeature(key, spec) { FEATURES[key] = spec.desc; FEATURE_LIST.push(key); SETUP[key] = spec; }
const actionRow = (...c) => new ActionRowBuilder().addComponents(...c);
const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const channelSelect = (id, placeholder) => new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setChannelTypes(...TEXT_CHANNELS);
const textInput = (id, label, { long = false, required = false, max, value, placeholder } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(required);
  if (max) t.setMaxLength(max);
  if (value) t.setValue(String(value).slice(0, max || 4000));
  if (placeholder) t.setPlaceholder(placeholder);
  return t;
};
const makeModal = (id, title, inputs) => new ModalBuilder().setCustomId(id).setTitle(clip(title, 45)).addComponents(...inputs.map((x) => actionRow(x)));
const sid = (viewer, feature, action, ...args) => ['su', viewer, feature, action, ...args].join(':');
const mid = (viewer, feature, action, ...args) => ['sm', viewer, feature, action, ...args].join(':');
const backButton = (viewer) => button(sid(viewer, 'home', 'open'), 'Back');
const panelEmbed = (guild, title) => embed(getConfig(guild.id)).setTitle(title);
const normHex = (s) => (s && /^#?[0-9a-f]{6}$/i.test(s.trim()) ? `#${s.trim().replace('#', '').toLowerCase()}` : null);
function assertCanPost(guild, ch) {
  const p = ch && ch.permissionsFor(guild.members.me);
  if (!p || !p.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) throw new UserError(`I cannot send embeds in ${ch ? `<#${ch.id}>` : 'that channel'}. Check my permissions there.`);
}

function setupStatus(gid, key) {
  switch (key) {
    case 'welcome': case 'goodbye': return getSetting(gid, key, {}).enabled ? 'On' : 'Off';
    case 'autorole': return (getSetting(gid, 'autorole', { roles: [] }).roles || []).length ? 'On' : 'Off';
    case 'rules': return getSetting(gid, 'rules', {}).text ? 'Written' : 'Not written';
    case 'logs': return getConfig(gid).mod_log_channel ? 'On' : 'Off';
    case 'applications': {
      const n = db.prepare('SELECT COUNT(*) n FROM applications WHERE guild_id = ?').get(gid).n;
      return n ? `${n} created` : 'None';
    }
    default: return SETUP[key] ? SETUP[key].status(gid) : '';
  }
}
function overviewPanel(guild, viewer) {
  const lines = Object.keys(FEATURES).map((k) => `**${capital(k)}** · ${setupStatus(guild.id, k)}`);
  const menu = new StringSelectMenuBuilder().setCustomId(sid(viewer, 'home', 'pick')).setPlaceholder('Choose a feature to set up')
    .addOptions(Object.entries(FEATURES).map(([k, d]) => ({ label: capital(k), description: clip(d, 100), value: k })));
  return { embeds: [panelEmbed(guild, 'Setup').setDescription(lines.join('\n\n'))], components: [actionRow(menu)] };
}
function greetingPanel(guild, viewer, kind) {
  const g = getSetting(guild.id, kind, {});
  const e = panelEmbed(guild, `Setup · ${capital(kind)}`).addFields(
    { name: 'Status', value: g.enabled ? 'On' : 'Off', inline: true },
    { name: 'Channel', value: g.channel ? `<#${g.channel}>` : 'Not set', inline: true },
    { name: 'Message', value: g.description ? clip(g.description, 900) : 'Not written' },
  ).setFooter({ text: `${FOOTER} · Variables: {user} {username} {server} {count}` });
  return {
    embeds: [e],
    components: [
      actionRow(channelSelect(sid(viewer, kind, 'channel'), 'Choose the channel')),
      actionRow(button(sid(viewer, kind, 'edit'), 'Edit message', ButtonStyle.Primary), button(sid(viewer, kind, 'toggle'), g.enabled ? 'Turn off' : 'Turn on'),
        button(sid(viewer, kind, 'preview'), 'Preview'), backButton(viewer)),
    ],
  };
}
function greetingEmbed(g, user, guild) {
  const fill = (t) => t.replaceAll('{user}', `<@${user.id}>`).replaceAll('{username}', user.username).replaceAll('{server}', guild.name).replaceAll('{count}', String(guild.memberCount));
  const e = new EmbedBuilder().setColor(normHex(g.color) || normHex(getConfig(guild.id).color) || '#2b2540').setDescription(fill(g.description)).setThumbnail(user.displayAvatarURL());
  if (g.title) e.setTitle(fill(g.title));
  return e;
}
function autorolePanel(guild, viewer) {
  const roles = getSetting(guild.id, 'autorole', { roles: [] }).roles || [];
  const e = panelEmbed(guild, 'Setup · Autorole')
    .setDescription(roles.length ? roles.map((r) => `<@&${r}>`).join(' ') : 'No roles selected. New members receive nothing automatically.')
    .setFooter({ text: `${FOOTER} · My highest role must sit above the roles you choose` });
  const menu = new RoleSelectMenuBuilder().setCustomId(sid(viewer, 'autorole', 'roles')).setPlaceholder('Choose up to 5 roles').setMinValues(0).setMaxValues(5);
  return { embeds: [e], components: [actionRow(menu), actionRow(backButton(viewer))] };
}
const rulesEmbed = (r, cfg) => embed(cfg).setTitle(r.title || 'Server rules').setDescription(r.text);
function rulesPanel(guild, viewer) {
  const r = getSetting(guild.id, 'rules', {});
  return {
    embeds: [panelEmbed(guild, 'Setup · Rules').setDescription(r.text ? clip(r.text, 1500) : 'No rules written yet.')],
    components: [
      actionRow(channelSelect(sid(viewer, 'rules', 'post'), 'Post the rules in a channel')),
      actionRow(button(sid(viewer, 'rules', 'edit'), 'Edit rules', ButtonStyle.Primary), backButton(viewer)),
    ],
  };
}
function logsPanel(guild, viewer) {
  const c = getConfig(guild.id);
  return {
    embeds: [panelEmbed(guild, 'Setup · Logs').setDescription(c.mod_log_channel ? `Moderation cases are sent to <#${c.mod_log_channel}>.` : 'Logging is off. Choose a channel to turn it on.')],
    components: [
      actionRow(channelSelect(sid(viewer, 'logs', 'channel'), 'Choose the log channel')),
      actionRow(button(sid(viewer, 'logs', 'clear'), 'Turn off', ButtonStyle.Secondary, !c.mod_log_channel), backButton(viewer)),
    ],
  };
}

// Applications
const getApp = (id, gid) => db.prepare('SELECT * FROM applications WHERE id = ? AND guild_id = ?').get(id, gid);
const appQuestions = (id) => db.prepare('SELECT * FROM application_questions WHERE app_id = ? ORDER BY position').all(id);
function appHome(guild, viewer) {
  const apps = db.prepare('SELECT a.*, (SELECT COUNT(*) FROM application_questions q WHERE q.app_id = a.id) AS qn FROM applications a WHERE guild_id = ? ORDER BY id').all(guild.id);
  const e = panelEmbed(guild, 'Setup · Applications').setDescription(apps.length
    ? apps.map((a) => `**${a.name}** · ${a.qn} question${a.qn === 1 ? '' : 's'} · ${a.panel_message ? 'published' : 'not published'}`).join('\n')
    : 'No applications yet. Create one and add your own questions; nothing is added for you.');
  const rows = [];
  if (apps.length) {
    rows.push(actionRow(new StringSelectMenuBuilder().setCustomId(sid(viewer, 'applications', 'open')).setPlaceholder('Open an application')
      .addOptions(apps.slice(0, 25).map((a) => ({ label: clip(a.name, 100), value: String(a.id) })))));
  }
  rows.push(actionRow(button(sid(viewer, 'applications', 'new'), 'New application', ButtonStyle.Primary, apps.length >= 25), backButton(viewer)));
  return { embeds: [e], components: rows };
}
function appPanel(guild, viewer, id) {
  const app = getApp(id, guild.id);
  if (!app) throw new UserError('That application no longer exists.');
  const qs = appQuestions(id);
  const waiting = db.prepare("SELECT COUNT(*) n FROM application_submissions WHERE guild_id = ? AND app_id = ? AND status = 'pending'").get(guild.id, id).n;
  const e = panelEmbed(guild, `Application · ${app.name}`).setDescription(app.description || 'No description set.').addFields(
    { name: 'Questions', value: qs.length ? clip(qs.map((q, n) => `${n + 1}. ${q.label}${q.required ? '' : ' (optional)'}`).join('\n'), 1000) : 'None yet. Add at least one before publishing.' },
    { name: 'Review channel', value: app.review_channel ? `<#${app.review_channel}>` : 'Not set', inline: true },
    { name: 'Reviewer role', value: app.reviewer_role ? `<@&${app.reviewer_role}>` : 'Not set', inline: true },
    { name: 'Published in', value: app.panel_channel ? `<#${app.panel_channel}>` : 'Not published', inline: true },
    { name: 'Limit', value: `${app.max_pending} waiting per member`, inline: true },
    { name: 'Awaiting review', value: String(waiting), inline: true },
  );
  return {
    embeds: [e],
    components: [
      actionRow(button(sid(viewer, 'applications', 'detail', id), 'Details', ButtonStyle.Primary), button(sid(viewer, 'applications', 'addq', id), 'Add question'),
        button(sid(viewer, 'applications', 'qmgr', id), 'Questions'), button(sid(viewer, 'applications', 'preview', id), 'Preview')),
      actionRow(channelSelect(sid(viewer, 'applications', 'revch', id), 'Where submissions are reviewed')),
      actionRow(new RoleSelectMenuBuilder().setCustomId(sid(viewer, 'applications', 'revrole', id)).setPlaceholder('Role allowed to review (optional)').setMinValues(0).setMaxValues(1)),
      actionRow(channelSelect(sid(viewer, 'applications', 'pub', id), 'Publish the Apply button in a channel')),
      actionRow(button(sid(viewer, 'applications', 'home'), 'Back'), button(sid(viewer, 'applications', 'del', id), 'Delete', ButtonStyle.Danger)),
    ],
  };
}
function qPanel(guild, viewer, id, sel) {
  const app = getApp(id, guild.id);
  if (!app) throw new UserError('That application no longer exists.');
  const qs = appQuestions(id);
  const idx = qs.findIndex((q) => String(q.id) === String(sel));
  const e = panelEmbed(guild, `Questions · ${app.name}`).setDescription(qs.length
    ? qs.map((q, n) => `**${n + 1}.** ${q.label} · ${q.style}${q.required ? '' : ' · optional'}`).join('\n')
    : 'No questions yet.');
  const rows = [];
  if (qs.length) {
    rows.push(actionRow(new StringSelectMenuBuilder().setCustomId(sid(viewer, 'applications', 'qsel', id)).setPlaceholder('Select a question to change')
      .addOptions(qs.slice(0, 25).map((q, n) => ({ label: `${n + 1}. ${clip(q.label, 90)}`, value: String(q.id), default: n === idx })))));
  }
  if (idx >= 0) {
    const q = qs[idx];
    rows.push(actionRow(
      button(sid(viewer, 'applications', 'qup', id, q.id), 'Move up', ButtonStyle.Secondary, idx === 0),
      button(sid(viewer, 'applications', 'qdown', id, q.id), 'Move down', ButtonStyle.Secondary, idx === qs.length - 1),
      button(sid(viewer, 'applications', 'qreq', id, q.id), q.required ? 'Make optional' : 'Make required'),
      button(sid(viewer, 'applications', 'qdel', id, q.id), 'Remove', ButtonStyle.Danger),
    ));
  }
  rows.push(actionRow(button(sid(viewer, 'applications', 'addq', id), 'Add question', ButtonStyle.Primary, qs.length >= 25),
    button(sid(viewer, 'applications', 'open', id), 'Back to application')));
  return { embeds: [e], components: rows };
}
async function setupRender(guild, viewer, feature, arg) {
  switch (feature) {
    case 'welcome': case 'goodbye': return greetingPanel(guild, viewer, feature);
    case 'autorole': return autorolePanel(guild, viewer);
    case 'rules': return rulesPanel(guild, viewer);
    case 'logs': return logsPanel(guild, viewer);
    case 'applications': return arg ? appPanel(guild, viewer, Number(arg)) : appHome(guild, viewer);
    default: return SETUP[feature] ? SETUP[feature].render(guild, viewer, arg) : overviewPanel(guild, viewer);
  }
}
const respond = (i, payload) => (i.isFromMessage && i.isFromMessage() ? i.update(payload) : i.reply({ ...payload, flags: MessageFlags.Ephemeral }));

async function handleSetup(i, feature, action, args) {
  const g = i.guild, v = i.user.id;
  const show = async (f, arg) => i.update(await setupRender(g, v, f, arg));
  if (feature === 'home') {
    const f = action === 'pick' ? i.values[0] : 'home';
    return show(FEATURES[f] ? f : 'home');
  }
  if (feature === 'welcome' || feature === 'goodbye') {
    const cur = getSetting(g.id, feature, {});
    if (action === 'channel') {
      assertCanPost(g, g.channels.cache.get(i.values[0]));
      putSetting(g.id, feature, { ...cur, channel: i.values[0] });
      return show(feature);
    }
    if (action === 'edit') {
      return i.showModal(makeModal(mid(v, feature, 'msg'), `${capital(feature)} message`, [
        textInput('title', 'Title (optional)', { max: 256, value: cur.title }),
        textInput('description', 'Message', { long: true, required: true, max: 2000, value: cur.description }),
        textInput('color', 'Color, hex (optional)', { max: 7, value: cur.color, placeholder: '#2b2540' }),
      ]));
    }
    if (action === 'toggle') {
      if (!cur.enabled && (!cur.channel || !cur.description)) throw new UserError('Choose a channel and write a message first.');
      putSetting(g.id, feature, { ...cur, enabled: !cur.enabled });
      return show(feature);
    }
    if (action === 'preview') {
      if (!cur.description) throw new UserError('Write a message first.');
      return i.reply({ embeds: [greetingEmbed(cur, i.user, g)], flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (feature === 'autorole' && action === 'roles') {
    const me = g.members.me, ok = [];
    for (const id of i.values) {
      const r = g.roles.cache.get(id);
      if (!r) continue;
      if (r.managed || r.id === g.id) throw new UserError(`I cannot assign ${r.name}.`);
      if (r.position >= me.roles.highest.position) throw new UserError(`${r.name} is above my highest role, so I cannot give it out.`);
      ok.push(id);
    }
    putSetting(g.id, 'autorole', { roles: ok });
    return show('autorole');
  }
  if (feature === 'rules') {
    const r = getSetting(g.id, 'rules', {});
    if (action === 'edit') {
      return i.showModal(makeModal(mid(v, 'rules', 'edit'), 'Server rules', [
        textInput('title', 'Title (optional)', { max: 100, value: r.title }),
        textInput('text', 'Rules', { long: true, required: true, max: 4000, value: r.text }),
      ]));
    }
    if (action === 'post') {
      if (!r.text) throw new UserError('Write the rules first.');
      const ch = g.channels.cache.get(i.values[0]);
      assertCanPost(g, ch);
      await ch.send({ embeds: [rulesEmbed(r, getConfig(g.id))] });
      await show('rules');
      return i.followUp({ embeds: [embed(getConfig(g.id), `Rules posted in <#${ch.id}>.`)], flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (feature === 'logs') {
    if (action === 'channel') {
      assertCanPost(g, g.channels.cache.get(i.values[0]));
      setConfig(g.id, 'mod_log_channel', i.values[0]);
    } else if (action === 'clear') setConfig(g.id, 'mod_log_channel', null);
    return show('logs');
  }
  if (feature === 'applications') return handleAppSetup(i, action, args);
  if (SETUP[feature]) return SETUP[feature].onComponent(i, action, args);
  return undefined;
}

async function handleAppSetup(i, action, args) {
  const g = i.guild, v = i.user.id;
  const show = async (arg) => i.update(await setupRender(g, v, 'applications', arg));
  const id = Number(action === 'open' && i.isStringSelectMenu() ? i.values[0] : args[0]);
  if (action === 'home') return show();
  if (action === 'new') {
    return i.showModal(makeModal(mid(v, 'applications', 'new'), 'New application', [
      textInput('name', 'Name', { required: true, max: 40, placeholder: 'For example: Staff, Partnership' }),
      textInput('description', 'Description (optional)', { long: true, max: 300 }),
    ]));
  }
  if (action === 'open') return show(id);
  const app = getApp(id, g.id);
  if (!app) throw new UserError('That application no longer exists.');
  switch (action) {
    case 'detail':
      return i.showModal(makeModal(mid(v, 'applications', 'detail', id), 'Application details', [
        textInput('name', 'Name', { required: true, max: 40, value: app.name }),
        textInput('description', 'Description', { long: true, max: 300, value: app.description }),
        textInput('limit', 'Waiting applications per member (1-10)', { required: true, max: 2, value: app.max_pending }),
        textInput('accept', 'Message sent on acceptance', { long: true, max: 500, value: app.accept_msg, placeholder: 'Variables: {user} {server}' }),
        textInput('reject', 'Message sent on rejection', { long: true, max: 500, value: app.reject_msg, placeholder: 'Variables: {user} {server}' }),
      ]));
    case 'addq':
      if (appQuestions(id).length >= 25) throw new UserError('An application can have at most 25 questions.');
      return i.showModal(makeModal(mid(v, 'applications', 'addq', id), 'Add a question', [
        textInput('label', 'Question (45 characters max)', { required: true, max: 45 }),
        textInput('style', 'Answer length: short or paragraph', { required: true, max: 9, value: 'short' }),
        textInput('required', 'Required: yes or no', { required: true, max: 3, value: 'yes' }),
      ]));
    case 'qmgr': return i.update(qPanel(g, v, id, null));
    case 'qsel': return i.update(qPanel(g, v, id, i.values[0]));
    case 'qup': case 'qdown': {
      const qs = appQuestions(id), idx = qs.findIndex((q) => String(q.id) === args[1]);
      const j = action === 'qup' ? idx - 1 : idx + 1;
      if (idx < 0 || j < 0 || j >= qs.length) return i.update(qPanel(g, v, id, args[1]));
      db.transaction(() => {
        db.prepare('UPDATE application_questions SET position = ? WHERE id = ?').run(qs[j].position, qs[idx].id);
        db.prepare('UPDATE application_questions SET position = ? WHERE id = ?').run(qs[idx].position, qs[j].id);
      })();
      return i.update(qPanel(g, v, id, args[1]));
    }
    case 'qreq':
      db.prepare('UPDATE application_questions SET required = 1 - required WHERE id = ? AND app_id = ?').run(args[1], id);
      return i.update(qPanel(g, v, id, args[1]));
    case 'qdel':
      db.transaction(() => {
        db.prepare('DELETE FROM application_questions WHERE id = ? AND app_id = ?').run(args[1], id);
        appQuestions(id).forEach((q, n) => db.prepare('UPDATE application_questions SET position = ? WHERE id = ?').run(n + 1, q.id));
      })();
      return i.update(qPanel(g, v, id, null));
    case 'preview': {
      const qs = appQuestions(id);
      if (!qs.length) throw new UserError('Add a question first.');
      return i.showModal(makeModal(mid(v, 'applications', 'pv', id), clip(`Preview: ${app.name}`, 45),
        qs.slice(0, 5).map((q) => textInput(`q${q.id}`, q.label, { long: q.style === 'paragraph', required: !!q.required, max: q.style === 'paragraph' ? 1000 : 300 }))));
    }
    case 'revch': {
      const ch = g.channels.cache.get(i.values[0]);
      assertCanPost(g, ch);
      db.prepare('UPDATE applications SET review_channel = ? WHERE id = ?').run(ch.id, id);
      return show(id);
    }
    case 'revrole':
      db.prepare('UPDATE applications SET reviewer_role = ? WHERE id = ?').run(i.values[0] || null, id);
      return show(id);
    case 'pub': {
      const qs = appQuestions(id);
      if (!qs.length) throw new UserError('Add at least one question before publishing.');
      if (!app.review_channel || !g.channels.cache.get(app.review_channel)) throw new UserError('Choose a review channel before publishing.');
      const ch = g.channels.cache.get(i.values[0]);
      assertCanPost(g, ch);
      const e = embed(getConfig(g.id)).setTitle(app.name).setDescription(app.description || 'Press the button below to apply.');
      const msg = await ch.send({ embeds: [e], components: [actionRow(button(`ap:apply:${id}`, 'Apply', ButtonStyle.Primary))] });
      if (app.panel_channel && app.panel_message) {
        const old = g.channels.cache.get(app.panel_channel);
        if (old) old.messages.delete(app.panel_message).catch(() => {});
      }
      db.prepare('UPDATE applications SET panel_channel = ?, panel_message = ? WHERE id = ?').run(ch.id, msg.id, id);
      return show(id);
    }
    case 'del':
      return i.update({
        embeds: [panelEmbed(g, `Delete ${app.name}?`).setDescription('The application and its questions will be removed and the Apply button will stop working. Submissions already sent for review can still be accepted or declined.')],
        components: [actionRow(button(sid(v, 'applications', 'delc', id), 'Delete', ButtonStyle.Danger), button(sid(v, 'applications', 'open', id), 'Cancel'))],
      });
    case 'delc':
      if (app.panel_channel && app.panel_message) {
        const old = g.channels.cache.get(app.panel_channel);
        if (old) old.messages.delete(app.panel_message).catch(() => {});
      }
      db.prepare('DELETE FROM applications WHERE id = ?').run(id);
      return show();
    default: return undefined;
  }
}

async function handleSetupModal(i, feature, action, args) {
  const g = i.guild, v = i.user.id, f = (k) => i.fields.getTextInputValue(k).trim();
  if (feature === 'welcome' || feature === 'goodbye') {
    const raw = f('color');
    if (raw && !normHex(raw)) throw new UserError('The color must be a six-digit hex code like #2b2540.');
    putSetting(g.id, feature, { ...getSetting(g.id, feature, {}), title: f('title'), description: f('description'), color: normHex(raw) });
    return respond(i, greetingPanel(g, v, feature));
  }
  if (feature === 'rules') {
    putSetting(g.id, 'rules', { title: f('title'), text: f('text') });
    return respond(i, rulesPanel(g, v));
  }
  if (feature !== 'applications') return SETUP[feature] ? SETUP[feature].onModal(i, action, args) : undefined;
  if (action === 'new') {
    if (db.prepare('SELECT COUNT(*) n FROM applications WHERE guild_id = ?').get(g.id).n >= 25) throw new UserError('A server can have at most 25 applications.');
    try {
      const r = db.prepare('INSERT INTO applications (guild_id, name, description, created_at) VALUES (?,?,?,?)').run(g.id, f('name'), f('description'), Date.now());
      return respond(i, appPanel(g, v, Number(r.lastInsertRowid)));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new UserError('An application with that name already exists.');
      throw e;
    }
  }
  const id = Number(args[0]);
  const app = getApp(id, g.id);
  if (!app) throw new UserError('That application no longer exists.');
  if (action === 'detail') {
    const limit = parseInt(f('limit'), 10);
    if (!(limit >= 1 && limit <= 10)) throw new UserError('The per-member limit must be a number from 1 to 10.');
    try {
      db.prepare('UPDATE applications SET name = ?, description = ?, max_pending = ?, accept_msg = ?, reject_msg = ? WHERE id = ?')
        .run(f('name'), f('description'), limit, f('accept'), f('reject'), id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new UserError('Another application already uses that name.');
      throw e;
    }
    return respond(i, appPanel(g, v, id));
  }
  if (action === 'addq') {
    const style = f('style').toLowerCase(), req = f('required').toLowerCase();
    if (!['short', 'paragraph'].includes(style)) throw new UserError('Answer length must be "short" or "paragraph".');
    if (!['yes', 'no'].includes(req)) throw new UserError('Required must be "yes" or "no".');
    const { n } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM application_questions WHERE app_id = ?').get(id);
    db.prepare('INSERT INTO application_questions (app_id, position, label, style, required) VALUES (?,?,?,?,?)').run(id, n, f('label'), style, req === 'yes' ? 1 : 0);
    return respond(i, qPanel(g, v, id, null));
  }
  if (action === 'pv') return i.reply({ embeds: [embed(getConfig(g.id), 'This was a preview. Nothing was saved or sent.')], flags: MessageFlags.Ephemeral });
  return undefined;
}

// Applicant side and review
const drafts = new Map();
const applyModal = (app, qs, chunk) => {
  const chunks = Math.ceil(qs.length / 5);
  return makeModal(`ap:m:${app.id}:${chunk}`, chunks > 1 ? `${app.name} (${chunk + 1}/${chunks})` : app.name,
    qs.slice(chunk * 5, chunk * 5 + 5).map((q) => textInput(`q${q.id}`, q.label, { long: q.style === 'paragraph', required: !!q.required, max: q.style === 'paragraph' ? 1000 : 300 })));
};
const reviewColor = { pending: 0x2b2540, accepted: 0x4a7c59, declined: 0x8b2f3a };
function reviewEmbed(sub, answers, note) {
  const limit = Math.max(100, Math.min(1000, Math.floor(5200 / Math.max(1, answers.length)) - 60));
  const e = new EmbedBuilder().setColor(reviewColor[sub.status]).setTitle(sub.app_name)
    .setDescription(`Applicant: <@${sub.user_id}>\nSubmitted ${ts(sub.created_at)}`)
    .addFields(answers.map((x) => ({ name: clip(x.q, 256), value: clip(x.a || 'No answer', limit) })))
    .setFooter({ text: `${FOOTER} · ${sub.status === 'pending' ? 'Awaiting review' : `${capital(sub.status)}${note ? `: ${clip(note, 200)}` : ''}`}` });
  return e;
}
const reviewButtons = (id) => actionRow(button(`ap:acc:${id}`, 'Accept', ButtonStyle.Success), button(`ap:dec:${id}`, 'Decline', ButtonStyle.Danger));
const canReview = (i, appId) => {
  if (i.memberPermissions.has(P.ManageGuild)) return true;
  const app = appId ? db.prepare('SELECT reviewer_role FROM applications WHERE id = ?').get(appId) : null;
  return !!(app && app.reviewer_role && i.member.roles.cache.has(app.reviewer_role));
};
async function decide(i, subId, status, note) {
  const sub = db.prepare('SELECT * FROM application_submissions WHERE id = ? AND guild_id = ?').get(subId, i.guild.id);
  if (!sub) throw new UserError('That application no longer exists.');
  if (!canReview(i, sub.app_id)) throw new UserError('You are not allowed to review this application.');
  if (sub.status !== 'pending') throw new UserError(`This application was already ${sub.status}.`);
  db.prepare('UPDATE application_submissions SET status = ?, reviewer_id = ?, note = ?, reviewed_at = ? WHERE id = ?').run(status, i.user.id, note || null, Date.now(), sub.id);
  sub.status = status;
  await i.update({ embeds: [reviewEmbed(sub, JSON.parse(sub.answers), note)], components: [] });
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(sub.app_id);
  const fill = (t) => t.replaceAll('{user}', `<@${sub.user_id}>`).replaceAll('{server}', i.guild.name);
  const custom = app ? (status === 'accepted' ? app.accept_msg : app.reject_msg) : '';
  let text = custom ? fill(custom) : `Your application "${sub.app_name}" in ${i.guild.name} was ${status}.`;
  if (status === 'declined' && note) text += `\n\nReason: ${note}`;
  const user = await client.users.fetch(sub.user_id).catch(() => null);
  const sent = user ? await user.send({ embeds: [new EmbedBuilder().setColor(reviewColor[status]).setDescription(text).setFooter({ text: i.guild.name })] }).then(() => true).catch(() => false) : false;
  await i.followUp({ embeds: [embed(getConfig(i.guild.id), sent ? 'The applicant was notified.' : 'The applicant could not be reached by DM.')], flags: MessageFlags.Ephemeral });
}
async function handleApplicationFlow(i, parts) {
  const [, action, idStr, extra] = parts;
  if (action === 'acc') return decide(i, Number(idStr), 'accepted', '');
  if (action === 'dec') {
    const sub = db.prepare('SELECT app_id FROM application_submissions WHERE id = ? AND guild_id = ?').get(Number(idStr), i.guild.id);
    if (!sub) throw new UserError('That application no longer exists.');
    if (!canReview(i, sub.app_id)) throw new UserError('You are not allowed to review this application.');
    return i.showModal(makeModal(`ap:decm:${idStr}`, 'Decline application', [textInput('reason', 'Reason (optional, sent to the applicant)', { long: true, max: 500 })]));
  }
  if (action === 'decm') return decide(i, Number(idStr), 'declined', i.fields.getTextInputValue('reason').trim());
  const app = getApp(Number(idStr), i.guild.id);
  const qs = app ? appQuestions(app.id) : [];
  if (!app || !app.panel_message || !qs.length || !app.review_channel) throw new UserError('This application is not open right now.');
  const key = `${i.guild.id}:${i.user.id}:${app.id}`;
  if (action === 'apply') {
    const waiting = db.prepare("SELECT COUNT(*) n FROM application_submissions WHERE guild_id = ? AND app_id = ? AND user_id = ? AND status = 'pending'").get(i.guild.id, app.id, i.user.id).n;
    if (waiting >= app.max_pending) throw new UserError('You already have an application waiting for review.');
    drafts.set(key, { answers: [], at: Date.now() });
    for (const [k, d] of drafts) if (Date.now() - d.at > 20 * 60 * 1000) drafts.delete(k);
    return i.showModal(applyModal(app, qs, 0));
  }
  const chunk = Number(extra);
  if (action === 'next') {
    if (!drafts.get(key)) throw new UserError('Your session expired. Press Apply again to start over.');
    return i.showModal(applyModal(app, qs, chunk));
  }
  if (action === 'm') {
    const draft = drafts.get(key);
    if (!draft || draft.answers.length !== chunk * 5) throw new UserError('Your session expired. Press Apply again to start over.');
    for (const q of qs.slice(chunk * 5, chunk * 5 + 5)) draft.answers.push({ q: q.label, a: i.fields.getTextInputValue(`q${q.id}`).trim() });
    if ((chunk + 1) * 5 < qs.length) {
      return i.reply({
        embeds: [embed(getConfig(i.guild.id), `Part ${chunk + 1} of ${Math.ceil(qs.length / 5)} saved. Continue to finish your application.`)],
        components: [actionRow(button(`ap:next:${app.id}:${chunk + 1}`, 'Continue', ButtonStyle.Primary))], flags: MessageFlags.Ephemeral,
      });
    }
    const ch = i.guild.channels.cache.get(app.review_channel);
    if (!ch) throw new UserError('The review channel is missing. Please let the staff know.');
    const info = db.prepare('INSERT INTO application_submissions (guild_id, app_id, app_name, user_id, answers, created_at) VALUES (?,?,?,?,?,?)')
      .run(i.guild.id, app.id, app.name, i.user.id, JSON.stringify(draft.answers), Date.now());
    const sub = db.prepare('SELECT * FROM application_submissions WHERE id = ?').get(info.lastInsertRowid);
    const msg = await ch.send({
      content: app.reviewer_role ? `<@&${app.reviewer_role}>` : undefined, embeds: [reviewEmbed(sub, draft.answers)], components: [reviewButtons(sub.id)],
      allowedMentions: { roles: app.reviewer_role ? [app.reviewer_role] : [] },
    }).catch(() => null);
    if (!msg) { db.prepare('DELETE FROM application_submissions WHERE id = ?').run(sub.id); throw new UserError('I could not post your application to the review channel. Please let the staff know.'); }
    db.prepare('UPDATE application_submissions SET channel_id = ?, message_id = ? WHERE id = ?').run(ch.id, msg.id, sub.id);
    drafts.delete(key);
    return i.reply({ embeds: [embed(getConfig(i.guild.id), 'Your application was submitted. You will be notified once it has been reviewed.')], flags: MessageFlags.Ephemeral });
  }
  return undefined;
}

define({
  name: 'setup', description: 'Set up a bot feature', category: 'Configuration', perm: P.ManageGuild,
  options: [opt('string', 'feature', 'Feature to set up (leave empty to see all)', false, { choices: FEATURE_LIST })],
  async run(ctx, a) { await ctx.reply(await setupRender(ctx.guild, ctx.user.id, a.feature || 'home'), { ephemeral: true }); },
});
for (const kind of ['welcome', 'goodbye']) {
  define({
    name: `set${kind}`, description: `Set up the ${kind} message`, category: 'Configuration', perm: P.ManageGuild,
    async run(ctx) { await ctx.reply(await setupRender(ctx.guild, ctx.user.id, kind), { ephemeral: true }); },
  });
}
define({
  name: 'rules', description: 'Show the server rules', category: 'Community',
  async run(ctx) {
    const r = getSetting(ctx.guild.id, 'rules', {});
    if (!r.text) throw new UserError('No rules have been written yet. Staff can add them with /setup rules.');
    await ctx.reply({ embeds: [rulesEmbed(r, ctx.cfg)] });
  },
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const me = member.guild.members.me;
    for (const id of getSetting(member.guild.id, 'autorole', { roles: [] }).roles || []) {
      const r = member.guild.roles.cache.get(id);
      if (r && !r.managed && me && r.position < me.roles.highest.position) await member.roles.add(r, 'Autorole').catch(() => {});
    }
    const w = getSetting(member.guild.id, 'welcome', {});
    if (w.enabled && w.channel && w.description) {
      const ch = member.guild.channels.cache.get(w.channel);
      if (ch) await ch.send({ embeds: [greetingEmbed(w, member.user, member.guild)], allowedMentions: { parse: [] } }).catch(() => {});
    }
  } catch (e) { console.error('Member join handler failed:', e); }
});
client.on(Events.GuildMemberRemove, async (member) => {
  try {
    const b = getSetting(member.guild.id, 'goodbye', {});
    if (b.enabled && b.channel && b.description) {
      const ch = member.guild.channels.cache.get(b.channel);
      if (ch) await ch.send({ embeds: [greetingEmbed(b, member.user, member.guild)], allowedMentions: { parse: [] } }).catch(() => {});
    }
  } catch (e) { console.error('Member leave handler failed:', e); }
});

/* -------------------------------- HELP ----------------------------------- */
const HELP_CATS = [
  ['Moderation', 'Warnings, timeouts, bans, channel tools and case records'],
  ['Discovery', 'Find spells, creatures and relics and keep a collection'],
  ['Magic', 'Fortunes, prophecies and the Oracle'],
  ['Tickets', 'Support tickets, transcripts and blocks'],
  ['Staff', 'Promotions, leave, reports, announcements and activity'],
  ['Events', 'Giveaways, scheduled events and trivia'],
  ['Shop', 'The shop, coins and your orders'],
  ['Fun', 'Games, rolls and playful commands'],
  ['Community', 'Server rules and member features'],
  ['Configuration', 'Prefix, logs and feature setup'],
  ['Utility', 'Information about members and the server'],
];
function helpPayload(cfg, viewer, cat) {
  const by = {};
  for (const c of commands) (by[c.category] ||= []).push(c);
  const shown = HELP_CATS.filter(([n]) => by[n]);
  const e = embed(cfg);
  if (!cat || !by[cat]) {
    e.setTitle('Wands of Fate').setDescription(`Moderation, discovery and community tools.\nPrefix \`${cfg.prefix}\` · Slash \`/\`\nUse \`/help <command>\` for details on one command.`);
    for (const [n, blurb] of shown) e.addFields({ name: n, value: blurb });
  } else {
    e.setTitle(cat).setDescription(by[cat].flatMap((c) => (c.subs
      ? Object.entries(c.subs).map(([s, d]) => `\`/${c.name} ${s}\`  ${d.description}`)
      : [`\`/${c.name}\`  ${c.description}`])).join('\n'));
  }
  const menu = new StringSelectMenuBuilder().setCustomId(`hp:${viewer}`).setPlaceholder('Browse commands').addOptions(
    { label: 'Overview', value: 'home', default: !cat || !by[cat] },
    ...shown.map(([n, blurb]) => ({ label: n, description: clip(blurb, 100), value: n, default: n === cat })),
  );
  return { embeds: [e], components: [actionRow(menu)] };
}
const usageLine = (name, def, prefix) => {
  const parts = (def.options || []).map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(' ');
  return `\`/${name} ${parts}\`\n\`${prefix}${name} ${parts}\``.replaceAll(' `', '`');
};
define({
  name: 'help', description: 'Browse commands or get help with one', category: 'Utility',
  options: [opt('string', 'command', 'A command name for details', false, { rest: true })],
  async run(ctx, a) {
    if (!a.command) return ctx.reply(helpPayload(ctx.cfg, ctx.user.id, null));
    const cmd = lookup.get(a.command.toLowerCase().replace(/^[/!]/, '').split(/\s+/)[0]);
    if (!cmd) throw new UserError(`There is no command called "${clip(a.command, 40)}".`);
    const e = embed(ctx.cfg).setTitle(`/${cmd.name}`).setDescription(cmd.description);
    if (cmd.subs) {
      e.addFields({ name: 'Usage', value: Object.entries(cmd.subs).map(([s, d]) => usageLine(`${cmd.name} ${s}`, d, ctx.cfg.prefix)).join('\n') });
    } else {
      e.addFields({ name: 'Usage', value: usageLine(cmd.name, cmd, ctx.cfg.prefix) });
      if (cmd.options && cmd.options.length) e.addFields({ name: 'Options', value: cmd.options.map((o) => `\`${o.name}\` ${o.description}`).join('\n') });
    }
    if (cmd.perm) e.addFields({ name: 'Requires', value: new PermissionsBitField(cmd.perm).toArray().join(', '), inline: true });
    if (cmd.aliases && cmd.aliases.length) e.addFields({ name: 'Also', value: cmd.aliases.map((x) => `\`${x}\``).join(' '), inline: true });
    await ctx.reply({ embeds: [e] });
  },
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.guild) return;
  const isSelect = i.isStringSelectMenu() || i.isChannelSelectMenu() || i.isRoleSelectMenu();
  if (!(i.isButton() || isSelect || i.isModalSubmit())) return;
  const parts = i.customId.split(':');
  const kind = parts[0];
  if (!['su', 'sm', 'ap', 'hp'].includes(kind)) return;
  try {
    if (kind === 'ap') return await handleApplicationFlow(i, parts);
    if (i.user.id !== parts[1]) {
      return await i.reply({ embeds: [failEmbed('This panel belongs to someone else. Run the command yourself to get your own.')], flags: MessageFlags.Ephemeral });
    }
    if (kind === 'hp') return await i.update(helpPayload(getConfig(i.guild.id), i.user.id, i.values[0]));
    if (!i.memberPermissions.has(P.ManageGuild)) throw new UserError('You need the Manage Server permission to change these settings.');
    const [, , feature, action, ...args] = parts;
    return await (kind === 'su' ? handleSetup(i, feature, action, args) : handleSetupModal(i, feature, action, args));
  } catch (err) {
    if (!(err instanceof UserError)) console.error('Interaction error:', err);
    const body = { embeds: [failEmbed(err instanceof UserError ? err.message : 'That did not work. The error has been logged.')], flags: MessageFlags.Ephemeral };
    (i.replied || i.deferred ? i.followUp(body) : i.reply(body)).catch(() => {});
  }
});


/* -------------------- 7d. FRAMEWORK FOR FEATURE MODULES ------------------- */
const TICKS = [];
const onTick = (fn) => TICKS.push(fn);
function startTicks() {
  setInterval(async () => {
    for (const fn of TICKS) { try { await fn(); } catch (e) { console.error('Tick failed:', e); } }
  }, 15e3);
}
const MESSAGE_HOOKS = [];
const onMessage = (fn) => MESSAGE_HOOKS.push(fn);
function route(prefix, handler) {
  client.on(Events.InteractionCreate, async (i) => {
    if (!i.guild || typeof i.customId !== 'string' || !i.customId.startsWith(`${prefix}:`)) return;
    try { await handler(i, i.customId.split(':')); } catch (err) {
      if (!(err instanceof UserError)) console.error(`${prefix} interaction error:`, err);
      const body = { embeds: [failEmbed(err instanceof UserError ? err.message : 'That did not work. The error has been logged.')], flags: MessageFlags.Ephemeral };
      (i.replied || i.deferred ? i.followUp(body) : i.reply(body)).catch(() => {});
    }
  });
}
function parseWhen(s) {
  const text = String(s).trim();
  const d = parseDuration(text);
  if (d) return Date.now() + d;
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (m) { const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]); if (!Number.isNaN(t)) return t; }
  return null;
}
const WHEN_HELP = 'Use a length like 2h or 3d, or a UTC time like 2026-12-01 20:00.';
const FORMS = {};
async function openForm(ctx, key, arg = '0', label = 'Open the form') {
  if (ctx.isSlash) return ctx.interaction.showModal(await FORMS[key](ctx.interaction, arg));
  return ctx.reply({ embeds: [embed(ctx.cfg, 'Press the button to continue.')], components: [actionRow(button(`fm:${ctx.user.id}:${key}:${arg}`, label, ButtonStyle.Primary))] });
}
route('fm', async (i, p) => {
  if (i.user.id !== p[1]) throw new UserError('That button belongs to someone else.');
  await i.showModal(await FORMS[p[2]](i, p[3]));
});
const today = () => new Date().toISOString().slice(0, 10);
const shuffle = (a) => { const r = [...a]; for (let k = r.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [r[k], r[j]] = [r[j], r[k]]; } return r; };

// Declarative setup panels: a feature lists its settings and gets a full panel (select, pickers, modals, toggles).
const KIND_HINT = { channel: 'Choose a channel', role: 'Choose a role', roles: 'Choose roles', toggle: 'Switch on or off', number: 'Enter a number', duration: 'Enter a length of time', text: 'Enter text' };
function showVal(f, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return 'Not set';
  switch (f.type) {
    case 'channel': return `<#${v}>`;
    case 'role': return `<@&${v}>`;
    case 'roles': return v.map((r) => `<@&${r}>`).join(' ');
    case 'toggle': return v ? 'On' : 'Off';
    case 'duration': return fmtDuration(v);
    case 'number': return `${v}${f.unit ? ` ${f.unit}` : ''}`;
    default: return clip(String(v), 200);
  }
}
function simpleFeature(key, spec) {
  const fieldOf = (k) => spec.fields.find((f) => f.k === k);
  const valueOf = (s, f) => (s[f.k] === undefined ? f.def : s[f.k]);
  function render(guild, viewer, arg) {
    const s = getSetting(guild.id, key, {});
    const e = panelEmbed(guild, `Setup · ${spec.title}`);
    if (spec.blurb) e.setDescription(spec.blurb);
    e.addFields(...spec.fields.map((f) => ({ name: f.label, value: showVal(f, valueOf(s, f)), inline: true })));
    if (spec.footer) e.setFooter({ text: `${FOOTER} · ${spec.footer}` });
    const rows = [actionRow(new StringSelectMenuBuilder().setCustomId(sid(viewer, key, 'pick')).setPlaceholder('Choose a setting to change')
      .addOptions(spec.fields.map((f) => ({ label: f.label, description: KIND_HINT[f.type], value: f.k, default: f.k === arg }))))];
    const cur = arg ? fieldOf(arg) : null;
    if (cur && cur.type === 'channel') {
      rows.push(actionRow(new ChannelSelectMenuBuilder().setCustomId(sid(viewer, key, 'set', cur.k)).setPlaceholder(`Choose: ${cur.label}`).setChannelTypes(...(cur.types || TEXT_CHANNELS))));
    }
    if (cur && (cur.type === 'role' || cur.type === 'roles')) {
      rows.push(actionRow(new RoleSelectMenuBuilder().setCustomId(sid(viewer, key, 'set', cur.k)).setPlaceholder(`Choose: ${cur.label}`)
        .setMinValues(0).setMaxValues(cur.type === 'roles' ? (cur.max || 10) : 1)));
    }
    const btns = (spec.actions || []).map((a) => button(sid(viewer, key, 'act', a.k), a.label, a.style || ButtonStyle.Secondary));
    if (cur && ['channel', 'role', 'roles'].includes(cur.type)) btns.push(button(sid(viewer, key, 'clear', cur.k), 'Clear this setting'));
    btns.push(backButton(viewer));
    rows.push(actionRow(...btns.slice(-5)));
    return { embeds: [e], components: rows };
  }
  async function onComponent(i, action, args) {
    const g = i.guild, v = i.user.id, s = getSetting(g.id, key, {});
    const show = (arg) => i.update(render(g, v, arg));
    if (action === 'pick') {
      const f = fieldOf(i.values[0]);
      if (!f) return undefined;
      if (f.type === 'toggle') { putSetting(g.id, key, { ...s, [f.k]: !valueOf(s, f) }); return show(); }
      if (['number', 'duration', 'text'].includes(f.type)) {
        const cur = valueOf(s, f);
        return i.showModal(makeModal(mid(v, key, 'val', f.k), f.label, [textInput('v', clip(f.hint || f.label, 45), {
          required: true, max: f.type === 'text' ? (f.max || 200) : 12,
          value: cur === undefined || cur === null ? '' : (f.type === 'duration' ? fmtDuration(cur) : cur), placeholder: f.placeholder,
        })]));
      }
      return show(f.k);
    }
    if (action === 'set') {
      const f = fieldOf(args[0]);
      if (!f) return undefined;
      let val;
      if (f.type === 'channel') {
        const ch = g.channels.cache.get(i.values[0]);
        if (ch && TEXT_CHANNELS.includes(ch.type) && f.post !== false) assertCanPost(g, ch);
        val = i.values[0] || null;
      } else val = f.type === 'roles' ? i.values : (i.values[0] || null);
      putSetting(g.id, key, { ...s, [f.k]: val });
      return show();
    }
    if (action === 'clear') { const next = { ...s }; delete next[args[0]]; putSetting(g.id, key, next); return show(); }
    if (action === 'act') {
      const a = (spec.actions || []).find((x) => x.k === args[0]);
      if (!a) return undefined;
      if (a.modal) return i.showModal(a.modal(g, v, s));
      const note = await a.run(i, g, s);
      await i.update(render(g, v));
      if (note) await i.followUp({ embeds: [embed(getConfig(g.id), note)], flags: MessageFlags.Ephemeral });
    }
    return undefined;
  }
  async function onModal(i, action, args) {
    const g = i.guild, s = getSetting(g.id, key, {});
    const fv = (k) => i.fields.getTextInputValue(k).trim();
    if (action === 'val') {
      const f = fieldOf(args[0]);
      const raw = fv('v');
      let val = raw;
      if (f.type === 'number') {
        val = parseInt(raw, 10);
        if (!(val >= (f.min ?? 0) && val <= (f.max ?? 1e9))) throw new UserError(`${f.label} must be a number from ${f.min ?? 0} to ${f.max ?? 1e9}.`);
      } else if (f.type === 'duration') {
        val = parseDuration(raw);
        if (!val) throw new UserError('Use a length of time like 30m, 2h or 1d.');
        if (f.maxMs && val > f.maxMs) throw new UserError(`That is too long. The most allowed is ${fmtDuration(f.maxMs)}.`);
      }
      putSetting(g.id, key, { ...s, [f.k]: val });
      return respond(i, render(g, i.user.id));
    }
    if (action === 'act') {
      const a = (spec.actions || []).find((x) => x.k === args[0]);
      const note = await a.submit(i, g, s, fv);
      await respond(i, render(g, i.user.id));
      if (note) await i.followUp({ embeds: [embed(getConfig(g.id), note)], flags: MessageFlags.Ephemeral });
    }
    return undefined;
  }
  function status(gid) {
    const s = getSetting(gid, key, {});
    const en = spec.fields.find((f) => f.k === 'enabled');
    if (en) return valueOf(s, en) ? 'On' : 'Off';
    const n = spec.fields.filter((f) => s[f.k] !== undefined && s[f.k] !== null && !(Array.isArray(s[f.k]) && !s[f.k].length)).length;
    return n ? `${n} set` : 'Not set';
  }
  registerFeature(key, { desc: spec.desc, status, render, onComponent, onModal });
}


/* ------------------------------ 7e. TICKETS ------------------------------ */
const getCat = (id, gid) => db.prepare('SELECT * FROM ticket_categories WHERE id = ? AND guild_id = ?').get(id, gid);
const ticketCats = (gid) => db.prepare('SELECT * FROM ticket_categories WHERE guild_id = ? ORDER BY id').all(gid);
const pad = (n) => String(n).padStart(4, '0');
const catQuestions = (c) => { try { return JSON.parse(c.questions); } catch { return []; } };

const MAX_SUPPORT_ROLES = 10;
// Old single role still counts, so categories you already set up keep working.
function catRoleIds(c) {
  let ids = [];
  try { ids = JSON.parse(c.support_roles || '[]'); } catch { ids = []; }
  if (!ids.length && c.support_role) ids = [c.support_role];
  return ids;
}
function catRoleSelect(guild, viewer, id, c) {
  const m = new RoleSelectMenuBuilder().setCustomId(sid(viewer, 'tickets', 'role', id)).setPlaceholder('Support roles for this category (up to 10)').setMinValues(0).setMaxValues(MAX_SUPPORT_ROLES);
  const have = catRoleIds(c).filter((r) => guild.roles.cache.has(r)).slice(0, MAX_SUPPORT_ROLES);
  if (have.length) m.setDefaultRoles(...have);
  return actionRow(m);
}

function ticketHome(guild, viewer) {
  const cats = ticketCats(guild.id), t = getSetting(guild.id, 'tickets', {});
  const e = panelEmbed(guild, 'Setup · Tickets').setDescription(cats.length
    ? cats.map((c) => `**${c.name}** · ${catQuestions(c).length} question${catQuestions(c).length === 1 ? '' : 's'}`).join('\n')
    : 'No ticket categories yet. Create one and decide its questions, roles and messages; nothing is added for you.')
    .addFields({ name: 'Transcripts', value: t.transcript ? `<#${t.transcript}>` : 'Not set', inline: true },
      { name: 'Ticket panel', value: t.panel_channel ? `<#${t.panel_channel}>` : 'Not published', inline: true });
  const rows = [];
  if (cats.length) {
    rows.push(actionRow(new StringSelectMenuBuilder().setCustomId(sid(viewer, 'tickets', 'open')).setPlaceholder('Open a category')
      .addOptions(cats.slice(0, 25).map((c) => ({ label: clip(c.name, 100), value: String(c.id) })))));
  }
  rows.push(actionRow(channelSelect(sid(viewer, 'tickets', 'transcript'), 'Where transcripts are sent')));
  rows.push(actionRow(channelSelect(sid(viewer, 'tickets', 'publish'), 'Publish the ticket panel in a channel')));
  rows.push(actionRow(button(sid(viewer, 'tickets', 'new'), 'New category', ButtonStyle.Primary, cats.length >= 25), button(sid(viewer, 'tickets', 'style'), `Panel style: ${t.panel_style === 'buttons' ? 'Buttons' : 'Menu'}`), button(sid(viewer, 'tickets', 'pnhome'), `Extra panels (${extraPanels(guild.id).length}/${MAX_EXTRA_PANELS})`), backButton(viewer)));
  return { embeds: [e], components: rows };
}
function ticketCatPanel(guild, viewer, id) {
  const c = getCat(id, guild.id);
  if (!c) throw new UserError('That category no longer exists.');
  const qs = catQuestions(c);
  const e = panelEmbed(guild, `Ticket category · ${c.name}`).setDescription(c.description || 'No description set.').addFields(
    { name: catRoleIds(c).length === 1 ? 'Support role' : 'Support roles', value: catRoleIds(c).length ? catRoleIds(c).map((r) => `<@&${r}>`).join(' ') : 'Not set', inline: true },
    { name: 'Created under', value: c.parent_channel ? `<#${c.parent_channel}>` : 'No category', inline: true },
    { name: 'Open limit', value: `${c.max_open} per member`, inline: true },
    { name: 'Opening questions', value: qs.length ? qs.map((q, n) => `${n + 1}. ${q}`).join('\n') : 'None' },
    { name: 'Welcome message', value: c.welcome_msg ? clip(c.welcome_msg, 500) : 'Not written' },
    { name: 'Closing message', value: c.close_msg ? clip(c.close_msg, 500) : 'Not written' },
  );
  return {
    embeds: [e],
    components: [
      actionRow(button(sid(viewer, 'tickets', 'detail', id), 'Details', ButtonStyle.Primary), button(sid(viewer, 'tickets', 'qs', id), 'Questions'), button(sid(viewer, 'tickets', 'del', id), 'Delete', ButtonStyle.Danger)),
      catRoleSelect(guild, viewer, id, c),
      actionRow(new ChannelSelectMenuBuilder().setCustomId(sid(viewer, 'tickets', 'parent', id)).setPlaceholder('Create tickets under this channel category').setChannelTypes(ChannelType.GuildCategory).setMinValues(0).setMaxValues(1)),
      actionRow(button(sid(viewer, 'tickets', 'home'), 'Back')),
    ],
  };
}
const TICKET_PANEL_TEXT = ['Open a ticket', 'Pick the category that fits and a private channel will be created for you and the staff.'];
function ticketChoice(guild, title, text) {
  const cats = ticketCats(guild.id);
  const e = embed(getConfig(guild.id)).setTitle(title).setDescription(text);
  if (getSetting(guild.id, 'tickets', {}).panel_style === 'buttons') {
    const components = [];
    for (let k = 0; k < Math.min(cats.length, 25); k += 5) components.push(actionRow(...cats.slice(k, k + 5).map((c) => button(`tk:ob:${c.id}`, clip(c.name, 80)))));
    return { embeds: [e], components };
  }
  const menu = new StringSelectMenuBuilder().setCustomId('tk:open').setPlaceholder('Choose a category').addOptions(cats.slice(0, 25).map((c) => {
    const o = { label: clip(c.name, 100), value: String(c.id) };
    if (c.description) o.description = clip(c.description, 100);
    return o;
  }));
  return { embeds: [e], components: [actionRow(menu)] };
}
async function postTicketPanel(guild, ch) {
  if (!ticketCats(guild.id).length) throw new UserError('Create at least one ticket category first.');
  assertCanPost(guild, ch);
  const msg = await ch.send(ticketChoice(guild, ...TICKET_PANEL_TEXT));
  const t = getSetting(guild.id, 'tickets', {});
  if (t.panel_channel && t.panel_message) { const old = guild.channels.cache.get(t.panel_channel); if (old) old.messages.delete(t.panel_message).catch(() => {}); }
  putSetting(guild.id, 'tickets', { ...t, panel_channel: ch.id, panel_message: msg.id });
}
async function refreshTicketPanel(guild) {
  await refreshExtraPanels(guild);
  const t = getSetting(guild.id, 'tickets', {});
  if (!t.panel_channel || !t.panel_message || !ticketCats(guild.id).length) return;
  const ch = guild.channels.cache.get(t.panel_channel), msg = ch ? await ch.messages.fetch(t.panel_message).catch(() => null) : null;
  if (msg) await msg.edit(ticketChoice(guild, ...TICKET_PANEL_TEXT)).catch(() => {});
}
registerFeature('tickets', {
  desc: 'Custom ticket categories, questions, roles and transcripts',
  status: (gid) => { const n = ticketCats(gid).length; return n ? `${n} categor${n === 1 ? 'y' : 'ies'}` : 'None'; },
  render: (guild, viewer, arg) => (arg ? ticketCatPanel(guild, viewer, Number(arg)) : ticketHome(guild, viewer)),
  async onComponent(i, action, args) {
    const g = i.guild, v = i.user.id;
    const show = async (arg, refresh = false) => { if (refresh) await refreshTicketPanel(g); return i.update(arg ? ticketCatPanel(g, v, Number(arg)) : ticketHome(g, v)); };
    const t = getSetting(g.id, 'tickets', {});
    if (action.startsWith('pn')) return extraPanelComponent(i, action, args);
    if (action === 'home') return show();
    if (action === 'style') { putSetting(g.id, 'tickets', { ...t, panel_style: t.panel_style === 'buttons' ? 'menu' : 'buttons' }); return show(null, true); }
    if (action === 'new') return i.showModal(makeModal(mid(v, 'tickets', 'new'), 'New ticket category', [
      textInput('name', 'Name', { required: true, max: 40, placeholder: 'For example: Support, Ban appeal' }), textInput('description', 'Description (optional)', { max: 100 })]));
    if (action === 'transcript') {
      const ch = g.channels.cache.get(i.values[0]);
      assertCanPost(g, ch);
      if (!ch.permissionsFor(g.members.me).has(P.AttachFiles)) throw new UserError(`I need Attach Files in <#${ch.id}> to send transcripts.`);
      putSetting(g.id, 'tickets', { ...t, transcript: ch.id });
      return show();
    }
    if (action === 'publish') { await postTicketPanel(g, g.channels.cache.get(i.values[0])); return show(); }
    const id = Number(action === 'open' && i.isStringSelectMenu() ? i.values[0] : args[0]);
    if (action === 'open') return show(id);
    const c = getCat(id, g.id);
    if (!c) throw new UserError('That category no longer exists.');
    switch (action) {
      case 'detail': return i.showModal(makeModal(mid(v, 'tickets', 'detail', id), 'Category details', [
        textInput('name', 'Name', { required: true, max: 40, value: c.name }), textInput('description', 'Description', { max: 100, value: c.description }),
        textInput('limit', 'Open tickets per member (1-10)', { required: true, max: 2, value: c.max_open }),
        textInput('welcome', 'Welcome message', { long: true, max: 800, value: c.welcome_msg, placeholder: 'Variables: {user} {category}' }),
        textInput('close', 'Closing message', { long: true, max: 800, value: c.close_msg })]));
      case 'qs': return i.showModal(makeModal(mid(v, 'tickets', 'qs', id), 'Opening questions', [
        textInput('lines', 'One question per line (5 max, 45 chars)', { long: true, max: 400, value: catQuestions(c).join('\n') })]));
      case 'role': db.prepare('UPDATE ticket_categories SET support_role = ?, support_roles = ? WHERE id = ?').run(i.values[0] || null, JSON.stringify(i.values), id); return show(id);
      case 'parent': db.prepare('UPDATE ticket_categories SET parent_channel = ? WHERE id = ?').run(i.values[0] || null, id); return show(id);
      case 'del': return i.update({
        embeds: [panelEmbed(g, `Delete ${c.name}?`).setDescription('The category is removed from the ticket panel. Existing tickets keep working.')],
        components: [actionRow(button(sid(v, 'tickets', 'delc', id), 'Delete', ButtonStyle.Danger), button(sid(v, 'tickets', 'open', id), 'Cancel'))],
      });
      case 'delc': db.prepare('DELETE FROM ticket_categories WHERE id = ?').run(id); return show(null, true);
      default: return undefined;
    }
  },
  async onModal(i, action, args) {
    const g = i.guild, v = i.user.id, f = (k) => i.fields.getTextInputValue(k).trim();
    if (action.startsWith('pn')) return extraPanelModal(i, action, args);
    try {
      if (action === 'new') {
        if (ticketCats(g.id).length >= 25) throw new UserError('A server can have at most 25 ticket categories.');
        const r = db.prepare('INSERT INTO ticket_categories (guild_id, name, description) VALUES (?,?,?)').run(g.id, f('name'), f('description'));
        await refreshTicketPanel(g);
        return respond(i, ticketCatPanel(g, v, Number(r.lastInsertRowid)));
      }
      const id = Number(args[0]);
      if (!getCat(id, g.id)) throw new UserError('That category no longer exists.');
      if (action === 'detail') {
        const limit = parseInt(f('limit'), 10);
        if (!(limit >= 1 && limit <= 10)) throw new UserError('The limit must be a number from 1 to 10.');
        db.prepare('UPDATE ticket_categories SET name = ?, description = ?, max_open = ?, welcome_msg = ?, close_msg = ? WHERE id = ?').run(f('name'), f('description'), limit, f('welcome'), f('close'), id);
      } else if (action === 'qs') {
        const lines = f('lines').split('\n').map((x) => x.trim()).filter(Boolean);
        if (lines.length > 5) throw new UserError('A form can hold at most 5 questions.');
        if (lines.some((x) => x.length > 45)) throw new UserError('Each question must be 45 characters or fewer.');
        db.prepare('UPDATE ticket_categories SET questions = ? WHERE id = ?').run(JSON.stringify(lines), id);
      }
      await refreshTicketPanel(g);
      return respond(i, ticketCatPanel(g, v, id));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new UserError('A category with that name already exists.');
      throw e;
    }
  },
});

/* ---- Extra ticket panels: up to 10 per server, each with its own categories, text, style and channel ---- */
const MAX_EXTRA_PANELS = 10;
const extraPanels = (gid) => db.prepare('SELECT * FROM ticket_panels WHERE guild_id = ? ORDER BY id').all(gid);
const getExtraPanel = (id, gid) => db.prepare('SELECT * FROM ticket_panels WHERE id = ? AND guild_id = ?').get(id, gid);
const panelCatIds = (p) => { try { return JSON.parse(p.categories).map(Number); } catch { return []; } };
const panelCats = (guild, p) => { const ids = panelCatIds(p); return ticketCats(guild.id).filter((c) => ids.includes(c.id)); };

function extraPanelsHome(guild, viewer) {
  const list = extraPanels(guild.id);
  const e = panelEmbed(guild, 'Setup · Ticket panels').setDescription(list.length
    ? list.map((p) => `**${p.name}** · ${panelCats(guild, p).length} categor${panelCats(guild, p).length === 1 ? 'y' : 'ies'} · ${p.message_id ? `posted in <#${p.channel_id}>` : 'not posted'}`).join('\n')
    : `No extra panels yet. You can create up to ${MAX_EXTRA_PANELS}, each with its own categories, text and style.`);
  const rows = [];
  if (list.length) {
    rows.push(actionRow(new StringSelectMenuBuilder().setCustomId(sid(viewer, 'tickets', 'pnopen')).setPlaceholder('Open a panel')
      .addOptions(list.map((p) => ({ label: clip(p.name, 100), value: String(p.id) })))));
  }
  rows.push(actionRow(button(sid(viewer, 'tickets', 'pnnew'), 'New panel', ButtonStyle.Primary, list.length >= MAX_EXTRA_PANELS), button(sid(viewer, 'tickets', 'home'), 'Back')));
  return { embeds: [e], components: rows };
}
function extraPanelView(guild, viewer, id) {
  const p = getExtraPanel(id, guild.id);
  if (!p) throw new UserError('That panel no longer exists.');
  const cats = panelCats(guild, p), all = ticketCats(guild.id);
  const e = panelEmbed(guild, `Ticket panel · ${p.name}`).setDescription(p.description || 'No text set.').addFields(
    { name: 'Heading', value: p.title || 'None', inline: true },
    { name: 'Style', value: p.style === 'buttons' ? 'Buttons' : 'Menu', inline: true },
    { name: 'Posted in', value: p.message_id ? `<#${p.channel_id}>` : 'Not posted', inline: true },
    { name: 'Categories', value: cats.length ? cats.map((c) => c.name).join(', ') : 'None chosen yet' },
  );
  const rows = [actionRow(button(sid(viewer, 'tickets', 'pndetail', id), 'Details', ButtonStyle.Primary), button(sid(viewer, 'tickets', 'pnstyle', id), `Style: ${p.style === 'buttons' ? 'Buttons' : 'Menu'}`), button(sid(viewer, 'tickets', 'pndel', id), 'Delete', ButtonStyle.Danger))];
  if (all.length) {
    const ids = panelCatIds(p);
    rows.push(actionRow(new StringSelectMenuBuilder().setCustomId(sid(viewer, 'tickets', 'pncats', id)).setPlaceholder('Categories shown on this panel')
      .setMinValues(0).setMaxValues(Math.min(all.length, 25))
      .addOptions(all.slice(0, 25).map((c) => ({ label: clip(c.name, 100), value: String(c.id), default: ids.includes(c.id) })))));
  }
  rows.push(actionRow(channelSelect(sid(viewer, 'tickets', 'pnpost', id), 'Post this panel in a channel')));
  rows.push(actionRow(button(sid(viewer, 'tickets', 'pnhome'), 'Back')));
  return { embeds: [e], components: rows };
}
function extraPanelMessage(guild, p) {
  const cats = panelCats(guild, p);
  const e = embed(getConfig(guild.id)).setTitle(p.title || 'Open a ticket').setDescription(p.description || TICKET_PANEL_TEXT[1]);
  if (p.style === 'buttons') {
    const components = [];
    for (let k = 0; k < cats.length; k += 5) components.push(actionRow(...cats.slice(k, k + 5).map((c) => button(`tk:ob:${c.id}`, clip(c.name, 80)))));
    return { embeds: [e], components };
  }
  const menu = new StringSelectMenuBuilder().setCustomId('tk:open').setPlaceholder('Choose a category').addOptions(cats.map((c) => {
    const o = { label: clip(c.name, 100), value: String(c.id) };
    if (c.description) o.description = clip(c.description, 100);
    return o;
  }));
  return { embeds: [e], components: [actionRow(menu)] };
}
async function postExtraPanel(guild, p, ch) {
  if (!panelCats(guild, p).length) throw new UserError('Choose at least one category for this panel first.');
  assertCanPost(guild, ch);
  const msg = await ch.send(extraPanelMessage(guild, p));
  if (p.channel_id && p.message_id) { const old = guild.channels.cache.get(p.channel_id); if (old) old.messages.delete(p.message_id).catch(() => {}); }
  db.prepare('UPDATE ticket_panels SET channel_id = ?, message_id = ? WHERE id = ?').run(ch.id, msg.id, p.id);
}
async function refreshExtraPanels(guild) {
  for (const p of extraPanels(guild.id)) {
    if (!p.channel_id || !p.message_id) continue;
    const ch = guild.channels.cache.get(p.channel_id), msg = ch ? await ch.messages.fetch(p.message_id).catch(() => null) : null;
    if (!msg) continue;
    if (!panelCats(guild, p).length) { msg.delete().catch(() => {}); db.prepare('UPDATE ticket_panels SET channel_id = NULL, message_id = NULL WHERE id = ?').run(p.id); continue; }
    await msg.edit(extraPanelMessage(guild, p)).catch(() => {});
  }
}
async function extraPanelComponent(i, action, args) {
  const g = i.guild, v = i.user.id;
  const show = async (id, refresh = false) => { if (refresh) await refreshExtraPanels(g); return i.update(id ? extraPanelView(g, v, id) : extraPanelsHome(g, v)); };
  if (action === 'pnhome') return show();
  if (action === 'pnnew') {
    if (extraPanels(g.id).length >= MAX_EXTRA_PANELS) throw new UserError(`A server can have at most ${MAX_EXTRA_PANELS} extra ticket panels.`);
    return i.showModal(makeModal(mid(v, 'tickets', 'pnnew'), 'New ticket panel', [
      textInput('name', 'Panel name (only you see this)', { required: true, max: 40, placeholder: 'For example: Support, Appeals' }),
      textInput('title', 'Heading shown on the panel', { max: 100, value: 'Open a ticket' }),
      textInput('description', 'Text shown on the panel', { long: true, max: 800, value: TICKET_PANEL_TEXT[1] })]));
  }
  const id = Number(action === 'pnopen' ? i.values[0] : args[0]);
  if (action === 'pnopen') return show(id);
  const p = getExtraPanel(id, g.id);
  if (!p) throw new UserError('That panel no longer exists.');
  switch (action) {
    case 'pndetail': return i.showModal(makeModal(mid(v, 'tickets', 'pndetail', id), 'Panel details', [
      textInput('name', 'Panel name (only you see this)', { required: true, max: 40, value: p.name }),
      textInput('title', 'Heading shown on the panel', { max: 100, value: p.title }),
      textInput('description', 'Text shown on the panel', { long: true, max: 800, value: p.description })]));
    case 'pnstyle': db.prepare('UPDATE ticket_panels SET style = ? WHERE id = ?').run(p.style === 'buttons' ? 'menu' : 'buttons', id); return show(id, true);
    case 'pncats': db.prepare('UPDATE ticket_panels SET categories = ? WHERE id = ?').run(JSON.stringify(i.values.map(Number)), id); return show(id, true);
    case 'pnpost': await postExtraPanel(g, p, g.channels.cache.get(i.values[0])); return show(id);
    case 'pndel': return i.update({
      embeds: [panelEmbed(g, `Delete ${p.name}?`).setDescription('The panel is deleted and its posted message is removed. Categories and existing tickets are not affected.')],
      components: [actionRow(button(sid(v, 'tickets', 'pndelc', id), 'Delete', ButtonStyle.Danger), button(sid(v, 'tickets', 'pnopen', id), 'Cancel'))],
    });
    case 'pndelc':
      if (p.channel_id && p.message_id) { const ch = g.channels.cache.get(p.channel_id); if (ch) ch.messages.delete(p.message_id).catch(() => {}); }
      db.prepare('DELETE FROM ticket_panels WHERE id = ?').run(id);
      return show();
    default: return undefined;
  }
}
async function extraPanelModal(i, action, args) {
  const g = i.guild, v = i.user.id, f = (k) => i.fields.getTextInputValue(k).trim();
  if (action === 'pnnew') {
    if (extraPanels(g.id).length >= MAX_EXTRA_PANELS) throw new UserError(`A server can have at most ${MAX_EXTRA_PANELS} extra ticket panels.`);
    const r = db.prepare('INSERT INTO ticket_panels (guild_id, name, title, description) VALUES (?,?,?,?)').run(g.id, f('name'), f('title') || 'Open a ticket', f('description') || TICKET_PANEL_TEXT[1]);
    return respond(i, extraPanelView(g, v, Number(r.lastInsertRowid)));
  }
  if (action === 'pndetail') {
    const id = Number(args[0]);
    if (!getExtraPanel(id, g.id)) throw new UserError('That panel no longer exists.');
    db.prepare('UPDATE ticket_panels SET name = ?, title = ?, description = ? WHERE id = ?').run(f('name'), f('title') || 'Open a ticket', f('description') || TICKET_PANEL_TEXT[1], id);
    await refreshExtraPanels(g);
    return respond(i, extraPanelView(g, v, id));
  }
  return undefined;
}

const fillTicket = (t, user, c) => t.replaceAll('{user}', `<@${user.id}>`).replaceAll('{category}', c.name);
const isStaffFor = (member, cat) => member.permissions.has(P.ManageChannels) || !!(cat && catRoleIds(cat).some((r) => member.roles.cache.has(r)));
// Opening message of a ticket: rebuilt from the ticket row so it can show who claimed it and flip the Claim button.
const ticketButtons = (tid, claimed) => actionRow(
  button(`tk:close:${tid}`, 'Close', ButtonStyle.Danger),
  button(`tk:claim:${tid}`, claimed ? 'Unclaim' : 'Claim', claimed ? ButtonStyle.Primary : ButtonStyle.Success),
);
async function ticketOpenMessage(g, t, cat) {
  const name = cat ? cat.name : t.category_name;
  const claimed = t.status === 'open' && !!t.claimed_by;
  const roles = cat ? catRoleIds(cat).filter((r) => g.roles.cache.has(r)) : [];
  let answers = [];
  try { answers = JSON.parse(t.answers || '[]'); } catch { answers = []; }
  const status = t.status === 'open' ? (claimed ? `🟡 Claimed by <@${t.claimed_by}>` : '🟢 Open · waiting for staff') : '🔴 Closed';
  const e = embed(getConfig(g.id))
    .setTitle(`🎫 ${name} · Ticket ${pad(t.num)}`)
    .setDescription(`${cat && cat.welcome_msg ? fillTicket(cat.welcome_msg, { id: t.user_id }, cat) : 'Describe what you need and a staff member will reply here.'}\n\u200b`)
    .addFields(
      { name: '👤 Opened by', value: `<@${t.user_id}>`, inline: true },
      { name: '🕒 Opened', value: `<t:${Math.floor(t.created_at / 1000)}:R>`, inline: true },
      { name: '📌 Status', value: status, inline: true },
    )
    .setFooter({ text: `${FOOTER} · Ticket ${pad(t.num)}` }).setTimestamp(t.created_at);
  if (roles.length) e.addFields({ name: '🛡️ Support team', value: roles.map((r) => `<@&${r}>`).join(' ') });
  const qs = cat ? catQuestions(cat) : [];
  qs.forEach((q, n) => {
    if (!answers[n]) return;
    e.addFields({ name: clip(`${n + 1}. ${q}`, 256), value: clip(answers[n], 900).split('\n').map((l) => `> ${l}`).join('\n') });
  });
  if (claimed) e.setColor(0x57f287);
  const u = await g.client.users.fetch(t.user_id).catch(() => null);
  if (u) e.setThumbnail(u.displayAvatarURL());
  return { embeds: [e], components: [ticketButtons(t.id, claimed)] };
}
async function syncTicketMessage(g, t) {
  const ch = t.channel_id && g.channels.cache.get(t.channel_id);
  if (!ch) return;
  const first = await ch.messages.fetch({ limit: 5, after: '0' }).catch(() => null);
  const msg = first && [...first.values()].find((m) => m.author.id === g.client.user.id && m.components.some((r) => r.components.some((c) => c.customId === `tk:claim:${t.id}`)));
  if (!msg) return;
  const cat = t.category_id ? getCat(t.category_id, g.id) : null;
  await msg.edit(await ticketOpenMessage(g, t, cat)).catch(() => {});
}
async function createTicket(i, cat) {
  const g = i.guild, answers = i.__answers || [];
  const num = db.prepare('SELECT COALESCE(MAX(num), 0) + 1 AS n FROM tickets WHERE guild_id = ?').get(g.id).n;
  const row = db.prepare('INSERT INTO tickets (guild_id, num, category_id, category_name, user_id, answers, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(g.id, num, cat.id, cat.name, i.user.id, JSON.stringify(answers), Date.now());
  const tid = Number(row.lastInsertRowid);
  try {
    const base = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
    const overwrites = [{ id: g.id, deny: [P.ViewChannel] }, { id: i.user.id, allow: base },
      { id: g.members.me.id, allow: [...base, P.ManageChannels, P.ManageMessages] }];
    const roles = catRoleIds(cat).map((r) => g.roles.cache.get(r)).filter(Boolean);
    for (const role of roles) overwrites.push({ id: role.id, allow: [...base, P.ManageMessages] });
    const parent = cat.parent_channel && g.channels.cache.get(cat.parent_channel);
    const ch = await g.channels.create({
      name: `${slugify(cat.name) || 'ticket'}-${pad(num)}`.slice(0, 100), type: ChannelType.GuildText, parent: parent ? parent.id : undefined,
      permissionOverwrites: overwrites, topic: `${cat.name} · opened by ${i.user.username} (${i.user.id})`,
    });
    db.prepare('UPDATE tickets SET channel_id = ? WHERE id = ?').run(ch.id, tid);
    const opening = await ticketOpenMessage(g, db.prepare('SELECT * FROM tickets WHERE id = ?').get(tid), cat);
    await ch.send({
      content: `<@${i.user.id}>${roles.map((r) => ` <@&${r.id}>`).join('')}`, ...opening,
      allowedMentions: { users: [i.user.id], roles: roles.map((r) => r.id) },
    });
    return ch;
  } catch (err) {
    db.prepare('DELETE FROM tickets WHERE id = ?').run(tid);
    throw err instanceof UserError ? err : new UserError('I could not create the ticket channel. Check that I have Manage Channels.');
  }
}
async function buildTranscript(channel) {
  const all = [];
  let before;
  for (let n = 0; n < 10; n++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  all.reverse();
  return all.map((m) => `[${new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19)}] ${m.author.username}${m.author.bot ? ' (bot)' : ''}: ${m.content || ''}`
    + `${m.embeds.length ? ` [embed: ${m.embeds.map((x) => x.title || x.description || '').join(' / ').slice(0, 200)}]` : ''}`
    + `${m.attachments.size ? ` [attachments: ${[...m.attachments.values()].map((a) => a.url).join(' ')}]` : ''}`).join('\n');
}
async function closeTicket(guild, ticket, closer, reason) {
  if (ticket.status !== 'open') throw new UserError('This ticket is already closed.');
  const ch = ticket.channel_id ? guild.channels.cache.get(ticket.channel_id) : null;
  const cat = ticket.category_id ? getCat(ticket.category_id, guild.id) : null;
  let text = ch ? await buildTranscript(ch) : '';
  text = `Ticket ${pad(ticket.num)} · ${ticket.category_name}\nOpened by ${ticket.user_id}\nClosed by ${closer.id}${reason ? ` · ${reason}` : ''}\n\n${text}`.slice(0, 400000);
  db.prepare("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ?, transcript = ? WHERE id = ?").run(Date.now(), closer.id, text, ticket.id);
  const t = getSetting(guild.id, 'tickets', {});
  const tc = t.transcript && guild.channels.cache.get(t.transcript);
  if (tc) {
    await tc.send({
      embeds: [embed(getConfig(guild.id)).setTitle(`Ticket ${pad(ticket.num)} closed`).addFields(
        { name: 'Category', value: ticket.category_name, inline: true }, { name: 'Opened by', value: `<@${ticket.user_id}>`, inline: true },
        { name: 'Closed by', value: `<@${closer.id}>`, inline: true }, { name: 'Reason', value: reason || 'No reason given' })],
      files: [new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `ticket-${pad(ticket.num)}.txt` })], allowedMentions: { parse: [] },
    }).catch(() => {});
  }
  if (ch) {
    await ch.permissionOverwrites.edit(ticket.user_id, { SendMessages: false }).catch(() => {});
    const msg = cat && cat.close_msg ? fillTicket(cat.close_msg, { id: ticket.user_id }, cat) : 'This ticket was closed.';
    await ch.send({ embeds: [embed(getConfig(guild.id), `${msg}${reason ? `\n\nReason: ${reason}` : ''}`)],
      components: [actionRow(button(`tk:reopen:${ticket.id}`, 'Reopen'), button(`tk:delete:${ticket.id}`, 'Delete channel', ButtonStyle.Danger))], allowedMentions: { parse: [] } }).catch(() => {});
  }
}
const ticketOf = (id, gid) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ? AND guild_id = ?').get(id, gid);
  if (!t) throw new UserError('That ticket no longer exists.');
  return t;
};
function assertCanOpen(g, user, cat) {
  if (db.prepare('SELECT 1 FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?').get(g.id, user.id)) throw new UserError('You are not allowed to open tickets in this server.');
  const open = db.prepare("SELECT COUNT(*) n FROM tickets WHERE guild_id = ? AND user_id = ? AND category_id = ? AND status = 'open'").get(g.id, user.id, cat.id).n;
  if (open >= cat.max_open) throw new UserError(`You already have ${open} open ticket${open === 1 ? '' : 's'} in this category.`);
}
route('tk', async (i, p) => {
  const g = i.guild, act = p[1];
  if (act === 'open' || act === 'ob') {
    const cat = getCat(Number(act === 'open' ? i.values[0] : p[2]), g.id);
    if (!cat) throw new UserError('That category no longer exists.');
    assertCanOpen(g, i.user, cat);
    const qs = catQuestions(cat);
    if (qs.length) return i.showModal(makeModal(`tk:oq:${cat.id}`, cat.name, qs.map((q, n) => textInput(`q${n}`, q, { long: true, required: true, max: 1000 }))));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const ch = await createTicket(i, cat);
    return i.editReply({ embeds: [embed(getConfig(g.id), `Your ticket is open: <#${ch.id}>`)] });
  }
  if (act === 'oq') {
    const cat = getCat(Number(p[2]), g.id);
    if (!cat) throw new UserError('That category no longer exists.');
    assertCanOpen(g, i.user, cat);
    i.__answers = catQuestions(cat).map((_, n) => i.fields.getTextInputValue(`q${n}`).trim());
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const ch = await createTicket(i, cat);
    return i.editReply({ embeds: [embed(getConfig(g.id), `Your ticket is open: <#${ch.id}>`)] });
  }
  const t = ticketOf(Number(p[2]), g.id);
  const cat = t.category_id ? getCat(t.category_id, g.id) : null;
  const staff = isStaffFor(i.member, cat);
  if (act === 'close') {
    if (!staff && i.user.id !== t.user_id) throw new UserError('Only the ticket owner or staff can close this ticket.');
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await closeTicket(g, t, i.user, '');
    return i.editReply({ embeds: [embed(getConfig(g.id), 'Ticket closed.')] });
  }
  if (!staff) throw new UserError('Only staff can do that.');
  if (act === 'claim') {
    const un = !!t.claimed_by;
    if (un && t.claimed_by !== i.user.id && !i.member.permissions.has(P.ManageChannels)) throw new UserError(`Only <@${t.claimed_by}> or a member with Manage Channels can unclaim this ticket.`);
    db.prepare('UPDATE tickets SET claimed_by = ? WHERE id = ?').run(un ? null : i.user.id, t.id);
    await i.update(await ticketOpenMessage(g, ticketOf(t.id, g.id), cat));
    return i.followUp({ embeds: [embed(getConfig(g.id), un ? `<@${i.user.id}> unclaimed this ticket. Any staff member can claim it now.` : `<@${i.user.id}> claimed this ticket.`)], allowedMentions: { parse: [] } });
  }
  if (act === 'reopen') {
    if (t.status !== 'closed') throw new UserError('This ticket is not closed.');
    db.prepare("UPDATE tickets SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = ?").run(t.id);
    await i.channel.permissionOverwrites.edit(t.user_id, { SendMessages: true }).catch(() => {});
    return i.update({ embeds: [embed(getConfig(g.id), `Ticket reopened by <@${i.user.id}>.`)], components: [actionRow(button(`tk:close:${t.id}`, 'Close', ButtonStyle.Danger))] });
  }
  if (act === 'delete') {
    db.prepare("UPDATE tickets SET status = 'deleted' WHERE id = ?").run(t.id);
    await i.reply({ embeds: [embed(getConfig(g.id), 'This channel will be deleted in 5 seconds. The transcript is kept.')] });
    setTimeout(() => i.channel.delete('Ticket deleted').catch(() => {}), 5000);
  }
  return undefined;
});

const ticketHere = (ctx) => {
  const t = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(ctx.channel.id);
  if (!t) throw new UserError('This is not a ticket channel.');
  return t;
};
const staffHere = (ctx, t) => {
  if (!isStaffFor(ctx.member, t.category_id ? getCat(t.category_id, ctx.guild.id) : null)) throw new UserError('Only staff can do that.');
};
define({
  name: 'ticket', description: 'Manage tickets', category: 'Tickets',
  subs: {
    setup: { description: 'Open the ticket setup panel', perm: P.ManageGuild, async run(ctx) { await ctx.reply(await setupRender(ctx.guild, ctx.user.id, 'tickets'), { ephemeral: true }); } },
    panel: { description: 'Post the ticket panel in this channel', perm: P.ManageGuild, async run(ctx) { await postTicketPanel(ctx.guild, ctx.channel); await ctx.ok('Ticket panel posted.', { ephemeral: true }); } },
    open: {
      description: 'Open a ticket and choose what it is about',
      async run(ctx) {
        if (!ticketCats(ctx.guild.id).length) throw new UserError('No ticket categories are set up yet.');
        await ctx.reply(ticketChoice(ctx.guild, 'What is your ticket about?', 'Choose a category and a private channel will be created for you and the staff.'), { ephemeral: true });
      },
    },
    close: {
      description: 'Close this ticket', options: [opt('string', 'reason', 'Reason', false, { rest: true })],
      async run(ctx, a) {
        const t = ticketHere(ctx);
        if (ctx.user.id !== t.user_id) staffHere(ctx, t);
        await ctx.defer();
        await closeTicket(ctx.guild, t, ctx.user, a.reason || '');
        if (ctx.isSlash) await ctx.ok('Ticket closed.');
      },
    },
    reopen: {
      description: 'Reopen this ticket',
      async run(ctx) {
        const t = ticketHere(ctx); staffHere(ctx, t);
        if (t.status !== 'closed') throw new UserError('This ticket is not closed.');
        db.prepare("UPDATE tickets SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = ?").run(t.id);
        await ctx.channel.permissionOverwrites.edit(t.user_id, { SendMessages: true });
        await ctx.ok('Ticket reopened.');
      },
    },
    claim: {
      description: 'Claim this ticket',
      async run(ctx) {
        const t = ticketHere(ctx); staffHere(ctx, t);
        const un = !!t.claimed_by;
        if (un && t.claimed_by !== ctx.user.id && !ctx.member.permissions.has(P.ManageChannels)) throw new UserError(`Only <@${t.claimed_by}> or a member with Manage Channels can unclaim this ticket.`);
        db.prepare('UPDATE tickets SET claimed_by = ? WHERE id = ?').run(un ? null : ctx.user.id, t.id);
        await syncTicketMessage(ctx.guild, ticketOf(t.id, ctx.guild.id));
        await ctx.ok(un ? `<@${ctx.user.id}> unclaimed this ticket.` : `<@${ctx.user.id}> claimed this ticket.`);
      },
    },
    add: {
      description: 'Add a member to this ticket', options: [opt('user', 'member', 'Member to add', true)],
      async run(ctx, a) {
        const t = ticketHere(ctx); staffHere(ctx, t);
        await ctx.channel.permissionOverwrites.edit(a.member.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        await ctx.ok(`<@${a.member.id}> was added to this ticket.`);
      },
    },
    remove: {
      description: 'Remove a member from this ticket', options: [opt('user', 'member', 'Member to remove', true)],
      async run(ctx, a) {
        const t = ticketHere(ctx); staffHere(ctx, t);
        if (a.member.id === t.user_id) throw new UserError('The ticket owner cannot be removed.');
        await ctx.channel.permissionOverwrites.delete(a.member.id);
        await ctx.ok(`<@${a.member.id}> was removed from this ticket.`);
      },
    },
    transcript: {
      description: 'Get this ticket\'s transcript',
      async run(ctx) {
        const t = ticketHere(ctx);
        if (ctx.user.id !== t.user_id) staffHere(ctx, t);
        await ctx.defer();
        const text = t.transcript || await buildTranscript(ctx.channel);
        await ctx.reply({ files: [new AttachmentBuilder(Buffer.from(text || 'Empty ticket.', 'utf8'), { name: `ticket-${pad(t.num)}.txt` })] });
      },
    },
    blacklist: {
      description: 'Block or unblock a member from opening tickets', perm: P.ManageGuild,
      options: [opt('string', 'action', 'add, remove or list', true, { choices: ['add', 'remove', 'list'] }), opt('user', 'member', 'Member'), opt('string', 'reason', 'Reason', false, { rest: true })],
      async run(ctx, a) {
        if (a.action === 'list') {
          const rows = db.prepare('SELECT * FROM ticket_blacklist WHERE guild_id = ? ORDER BY at DESC LIMIT 25').all(ctx.guild.id);
          return ctx.ok(rows.length ? rows.map((r) => `<@${r.user_id}>${r.reason ? ` · ${clip(r.reason, 80)}` : ''}`).join('\n') : 'Nobody is blocked from opening tickets.');
        }
        if (!a.member) throw new UserError('Choose a member.');
        if (a.action === 'add') {
          db.prepare('INSERT INTO ticket_blacklist (guild_id, user_id, reason, at) VALUES (?,?,?,?) ON CONFLICT (guild_id, user_id) DO UPDATE SET reason = excluded.reason')
            .run(ctx.guild.id, a.member.id, a.reason || '', Date.now());
          return ctx.ok(`<@${a.member.id}> can no longer open tickets.`);
        }
        const r = db.prepare('DELETE FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?').run(ctx.guild.id, a.member.id);
        if (!r.changes) throw new UserError('That member is not blocked.');
        return ctx.ok(`<@${a.member.id}> can open tickets again.`);
      },
    },
  },
});


/* ------------------------- 7f. STAFF MANAGEMENT -------------------------- */
const staffSet = (gid) => getSetting(gid, 'staff', {});
const hierarchyOf = (guild) => (staffSet(guild.id).hierarchy || []).map((id) => guild.roles.cache.get(id)).filter(Boolean).sort((a, b) => a.position - b.position);
async function staffChannel(guild, key, payload) {
  const ch = staffSet(guild.id)[key] && guild.channels.cache.get(staffSet(guild.id)[key]);
  if (!ch) return null;
  return ch.send(payload).catch(() => null);
}
const addRecord = (gid, userId, type, detail, byId) => db.prepare('INSERT INTO staff_records (guild_id, user_id, type, detail, by_id, at) VALUES (?,?,?,?,?,?)').run(gid, userId, type, detail, byId, Date.now());

simpleFeature('staff', {
  title: 'Staff', desc: 'Hierarchy, leave, reports, announcements and activity',
  blurb: 'Roles you choose as the hierarchy are ordered by their position in the server, lowest first.',
  fields: [
    { k: 'hierarchy', label: 'Staff hierarchy', type: 'roles', max: 10 },
    { k: 'leave_role', label: 'On-leave role', type: 'role' },
    { k: 'announce_channel', label: 'Announcements channel', type: 'channel' },
    { k: 'announce_ping', label: 'Announcement ping', type: 'role' },
    { k: 'leave_channel', label: 'Leave requests channel', type: 'channel' },
    { k: 'report_channel', label: 'Reports channel', type: 'channel' },
    { k: 'log_channel', label: 'Staff log channel', type: 'channel' },
    { k: 'activity', label: 'Activity tracking', type: 'toggle', def: true },
  ],
});

async function moveStaff(ctx, a, dir) {
  const hier = hierarchyOf(ctx.guild);
  if (!hier.length) throw new UserError('Set the staff hierarchy first with /setup staff.');
  const member = await requireMember(ctx, a.member);
  if (member.id === ctx.user.id) throw new UserError('You cannot change your own rank.');
  const idx = hier.reduce((best, r, n) => (member.roles.cache.has(r.id) ? n : best), -1);
  const from = idx >= 0 ? hier[idx] : null;
  let to;
  if (dir > 0) {
    if (idx >= hier.length - 1) throw new UserError('That member already holds the highest staff role.');
    to = hier[idx + 1];
  } else {
    if (idx < 0) throw new UserError('That member holds no staff role.');
    to = idx > 0 ? hier[idx - 1] : null;
  }
  const me = ctx.guild.members.me;
  for (const r of [from, to].filter(Boolean)) {
    if (r.position >= me.roles.highest.position) throw new UserError(`${r.name} is above my highest role, so I cannot move it.`);
    if (ctx.user.id !== ctx.guild.ownerId && r.position >= ctx.member.roles.highest.position) throw new UserError(`${r.name} is equal to or above your own highest role.`);
  }
  const reason = a.reason || (dir > 0 ? 'Promotion' : 'Demotion');
  if (from) await member.roles.remove(from.id, auditReason(ctx, reason));
  if (to) await member.roles.add(to.id, auditReason(ctx, reason));
  const detail = `${from ? from.name : 'No staff role'} to ${to ? to.name : 'No staff role'} · ${reason}`;
  addRecord(ctx.guild.id, member.id, dir > 0 ? 'promotion' : 'demotion', detail, ctx.user.id);
  await staffChannel(ctx.guild, 'log_channel', { embeds: [embed(ctx.cfg).setTitle(dir > 0 ? 'Promotion' : 'Demotion')
    .addFields({ name: 'Member', value: `<@${member.id}>`, inline: true }, { name: 'By', value: `<@${ctx.user.id}>`, inline: true }, { name: 'Change', value: detail })], allowedMentions: { parse: [] } });
  await ctx.ok(`<@${member.id}> ${dir > 0 ? 'was promoted' : 'was demoted'}${to ? ` to **${to.name}**` : ' and no longer holds a staff role'}.`);
}
const rankOpts = [opt('user', 'member', 'Staff member', true), opt('string', 'reason', 'Reason', false, { rest: true })];
define({ name: 'promote', description: 'Promote a staff member one rank', category: 'Staff', perm: P.ManageRoles, botPerms: P.ManageRoles, options: rankOpts, run: (ctx, a) => moveStaff(ctx, a, 1) });
define({ name: 'demote', description: 'Demote a staff member one rank', category: 'Staff', perm: P.ManageRoles, botPerms: P.ManageRoles, options: rankOpts, run: (ctx, a) => moveStaff(ctx, a, -1) });
define({
  name: 'staffnote', description: 'Add a performance note to a staff member\'s record', category: 'Staff', perm: P.ManageRoles,
  options: [opt('user', 'member', 'Staff member', true), opt('string', 'note', 'The note', true, { rest: true, maxLength: 500 })],
  async run(ctx, a) {
    addRecord(ctx.guild.id, a.member.id, 'note', clip(a.note, 500), ctx.user.id);
    await ctx.ok(`Note added to <@${a.member.id}>'s record.`);
  },
});
define({
  name: 'staffrecord', description: 'View a staff member\'s record', category: 'Staff', perm: P.ManageRoles,
  options: [opt('user', 'member', 'Staff member', true)],
  async run(ctx, a) {
    const rows = db.prepare('SELECT * FROM staff_records WHERE guild_id = ? AND user_id = ? ORDER BY at DESC LIMIT 15').all(ctx.guild.id, a.member.id);
    const acts = db.prepare('SELECT COUNT(*) n FROM cases WHERE guild_id = ? AND mod_id = ? AND created_at > ?').get(ctx.guild.id, a.member.id, Date.now() - 30 * 864e5).n;
    const e = embed(ctx.cfg).setTitle(`Record · ${a.member.username}`).addFields({ name: 'Moderation actions, last 30 days', value: String(acts) });
    e.setDescription(rows.length ? rows.map((r) => `**${capital(r.type)}** · ${ts(r.at)} by <@${r.by_id}>\n${clip(r.detail, 200)}`).join('\n\n') : 'No records yet.');
    await ctx.reply({ embeds: [e] });
  },
});
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
// Leave of absence
FORMS.leave = () => makeModal('lv:req', 'Leave of absence', [
  textInput('reason', 'Reason', { long: true, required: true, max: 500 }),
  textInput('until', 'Until (for example 7d or 2026-12-01 20:00)', { required: true, max: 20 }),
]);
FORMS.announce = () => makeModal('lv:ann', 'Staff announcement', [
  textInput('title', 'Title (optional)', { max: 200 }), textInput('message', 'Message', { long: true, required: true, max: 2000 }),
]);
define({ name: 'leave', description: 'Request a leave of absence', category: 'Staff', run: (ctx) => openForm(ctx, 'leave', '0', 'Request leave') });
define({ name: 'staffannounce', description: 'Post a staff announcement', category: 'Staff', perm: P.ManageMessages, run: (ctx) => openForm(ctx, 'announce', '0', 'Write announcement') });
define({
  name: 'leavelist', description: 'List staff currently on leave', category: 'Staff', perm: P.ManageRoles,
  async run(ctx) {
    const rows = db.prepare("SELECT * FROM leaves WHERE guild_id = ? AND status = 'approved' ORDER BY end_at").all(ctx.guild.id);
    await ctx.ok(rows.length ? rows.map((r) => `<@${r.user_id}> · back ${ts(r.end_at)}\n${clip(r.reason, 100)}`).join('\n\n') : 'Nobody is on leave.');
  },
});
route('lv', async (i, p) => {
  const g = i.guild, s = staffSet(g.id);
  if (p[1] === 'req') {
    const ch = s.leave_channel && g.channels.cache.get(s.leave_channel);
    if (!ch) throw new UserError('Leave requests are not set up. Ask an admin to choose a channel in /setup staff.');
    if ((s.hierarchy || []).length && !s.hierarchy.some((id) => i.member.roles.cache.has(id))) throw new UserError('Only staff can request leave.');
    const end = parseWhen(i.fields.getTextInputValue('until'));
    if (!end || end <= Date.now()) throw new UserError(`That end date is not valid. ${WHEN_HELP}`);
    if (end - Date.now() > 90 * 864e5) throw new UserError('Leave can be at most 90 days.');
    if (db.prepare("SELECT 1 FROM leaves WHERE guild_id = ? AND user_id = ? AND status IN ('pending','approved')").get(g.id, i.user.id)) throw new UserError('You already have a leave request pending or active.');
    const reason = i.fields.getTextInputValue('reason').trim();
    const r = db.prepare('INSERT INTO leaves (guild_id, user_id, reason, end_at, created_at) VALUES (?,?,?,?,?)').run(g.id, i.user.id, reason, end, Date.now());
    const id = Number(r.lastInsertRowid);
    await ch.send({ embeds: [embed(getConfig(g.id)).setTitle('Leave request').setDescription(`<@${i.user.id}> · until ${ts(end, 'f')}\n\n${clip(reason, 1000)}`)],
      components: [actionRow(button(`lv:ok:${id}`, 'Approve', ButtonStyle.Success), button(`lv:no:${id}`, 'Deny', ButtonStyle.Danger))], allowedMentions: { parse: [] } });
    return i.reply({ embeds: [embed(getConfig(g.id), 'Your leave request was sent for review.')], flags: MessageFlags.Ephemeral });
  }
  if (p[1] === 'ann') {
    const ch = s.announce_channel && g.channels.cache.get(s.announce_channel);
    if (!ch) throw new UserError('No announcements channel is set. Choose one in /setup staff.');
    if (!i.memberPermissions.has(P.ManageMessages)) throw new UserError('You cannot post announcements.');
    const title = i.fields.getTextInputValue('title').trim();
    const e = embed(getConfig(g.id), i.fields.getTextInputValue('message').trim());
    if (title) e.setTitle(title);
    await ch.send({ content: s.announce_ping ? `<@&${s.announce_ping}>` : undefined, embeds: [e], allowedMentions: { roles: s.announce_ping ? [s.announce_ping] : [] } });
    return i.reply({ embeds: [embed(getConfig(g.id), `Announcement posted in <#${ch.id}>.`)], flags: MessageFlags.Ephemeral });
  }
  if (!i.memberPermissions.has(P.ManageRoles) && !i.memberPermissions.has(P.ManageGuild)) throw new UserError('You cannot review leave requests.');
  const lv = db.prepare('SELECT * FROM leaves WHERE id = ? AND guild_id = ?').get(Number(p[2]), g.id);
  if (!lv || lv.status !== 'pending') throw new UserError('This request was already handled.');
  const ok = p[1] === 'ok';
  db.prepare('UPDATE leaves SET status = ?, reviewer_id = ? WHERE id = ?').run(ok ? 'approved' : 'denied', i.user.id, lv.id);
  if (ok && s.leave_role) {
    const m = await g.members.fetch(lv.user_id).catch(() => null);
    if (m) await m.roles.add(s.leave_role, 'Leave approved').catch(() => {});
  }
  addRecord(g.id, lv.user_id, ok ? 'leave' : 'leave denied', `${clip(lv.reason, 200)} · until ${new Date(lv.end_at).toISOString().slice(0, 10)}`, i.user.id);
  const user = await client.users.fetch(lv.user_id).catch(() => null);
  if (user) user.send({ embeds: [embed(getConfig(g.id), `Your leave request in ${g.name} was ${ok ? 'approved' : 'denied'}.`)] }).catch(() => {});
  await i.update({ embeds: [embed(getConfig(g.id)).setTitle('Leave request').setDescription(`<@${lv.user_id}> · until ${ts(lv.end_at, 'f')}\n\n${clip(lv.reason, 1000)}`)
    .setFooter({ text: `${FOOTER} · ${ok ? 'Approved' : 'Denied'} by ${i.user.username}` })], components: [] });
});
onTick(async () => {
  const due = db.prepare("SELECT * FROM leaves WHERE status = 'approved' AND end_at <= ?").all(Date.now());
  for (const lv of due) {
    const g = client.guilds.cache.get(lv.guild_id);
    if (!g) continue;
    const role = staffSet(g.id).leave_role;
    if (role) { const m = await g.members.fetch(lv.user_id).catch(() => null); if (m) await m.roles.remove(role, 'Leave ended').catch(() => {}); }
    db.prepare("UPDATE leaves SET status = 'ended' WHERE id = ?").run(lv.id);
  }
});

// Reports
async function fileReport(ctx, a, anonymous) {
  const s = staffSet(ctx.guild.id);
  const ch = s.report_channel && ctx.guild.channels.cache.get(s.report_channel);
  if (!ch) throw new UserError('Reports are not set up yet. Ask an admin to choose a channel in /setup staff.');
  if (!ctx.isSlash) await ctx.message.delete().catch(() => {});
  const r = db.prepare('INSERT INTO reports (guild_id, reporter_id, target_id, reason, anonymous, channel_id, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(ctx.guild.id, ctx.user.id, a.member ? a.member.id : null, a.reason, anonymous ? 1 : 0, ctx.channel.id, Date.now());
  const id = Number(r.lastInsertRowid);
  const e = embed(ctx.cfg).setTitle(`${anonymous ? 'Anonymous report' : 'Report'} #${id}`).addFields(
    { name: 'Reported by', value: anonymous ? 'Anonymous' : `<@${ctx.user.id}>`, inline: true },
    ...(a.member ? [{ name: 'Member', value: `<@${a.member.id}>`, inline: true }] : []),
    { name: 'Channel', value: `<#${ctx.channel.id}>`, inline: true }, { name: 'Details', value: clip(a.reason, 1000) });
  const msg = await ch.send({ embeds: [e], components: [actionRow(button(`rp:done:${id}`, 'Mark handled'))], allowedMentions: { parse: [] } });
  db.prepare('UPDATE reports SET message_id = ? WHERE id = ?').run(msg.id, id);
  await ctx.reply({ embeds: [embed(ctx.cfg, anonymous ? 'Your report was sent. Staff cannot see who sent it unless an admin looks it up.' : 'Your report was sent to the staff.')] }, { ephemeral: true, deleteAfter: 8000 });
}
define({ name: 'report', description: 'Report a member to the staff', category: 'Staff', options: [opt('user', 'member', 'Member you are reporting', true), opt('string', 'reason', 'What happened', true, { rest: true, maxLength: 1000 })], run: (ctx, a) => fileReport(ctx, a, false) });
define({ name: 'anonreport', description: 'Send a report without your name attached', category: 'Staff', options: [opt('string', 'reason', 'What happened', true, { rest: true, maxLength: 1000 })], run: (ctx, a) => fileReport(ctx, a, true) });
define({
  name: 'reportinfo', description: 'Look up who sent a report (admins only)', category: 'Staff', perm: P.ManageGuild,
  options: [opt('int', 'id', 'Report number', true, { min: 1 })],
  async run(ctx, a) {
    const r = db.prepare('SELECT * FROM reports WHERE id = ? AND guild_id = ?').get(a.id, ctx.guild.id);
    if (!r) throw new UserError(`Report #${a.id} does not exist.`);
    await ctx.reply({ embeds: [embed(ctx.cfg).setTitle(`Report #${r.id}`).addFields({ name: 'Sent by', value: `<@${r.reporter_id}>`, inline: true },
      { name: 'Anonymous', value: r.anonymous ? 'Yes' : 'No', inline: true }, { name: 'Sent', value: ts(r.created_at), inline: true }, { name: 'Details', value: clip(r.reason, 1000) })] }, { ephemeral: true });
  },
});
route('rp', async (i, p) => {
  if (!i.memberPermissions.has(P.ManageMessages)) throw new UserError('Only staff can do that.');
  const e = EmbedBuilder.from ? EmbedBuilder.from(i.message.embeds[0]) : embed(getConfig(i.guild.id));
  await i.update({ embeds: [e.setFooter({ text: `${FOOTER} · Handled by ${i.user.username}` })], components: [] });
});


/* ------------------- 7g. GIVEAWAYS, EVENTS AND TRIVIA -------------------- */
simpleFeature('giveaways', {
  title: 'Giveaways', desc: 'Default channel, ping role and winner notices',
  blurb: 'Start giveaways with /giveaway start. These settings are the defaults.',
  fields: [
    { k: 'channel', label: 'Giveaway channel', type: 'channel' },
    { k: 'ping_role', label: 'Ping role', type: 'role' },
    { k: 'dm_winners', label: 'Message winners', type: 'toggle', def: true },
  ],
});
simpleFeature('events', {
  title: 'Events', desc: 'Announcement channel, ping role and reminder time',
  blurb: 'Create events with /event create. Reminders ping everyone who joined.',
  fields: [
    { k: 'channel', label: 'Event channel', type: 'channel' },
    { k: 'ping_role', label: 'Ping role', type: 'role' },
    { k: 'reminder', label: 'Reminder before start', type: 'duration', def: 15 * 60e3, maxMs: 864e5, hint: 'Time before start (for example 15m)' },
  ],
});
const gwCount = (id) => db.prepare('SELECT COUNT(*) n FROM giveaway_entries WHERE giveaway_id = ?').get(id).n;
function gwEmbed(cfg, g) {
  const active = g.status === 'active';
  const w = JSON.parse(g.winner_ids || '[]');
  const lines = [`Hosted by <@${g.host_id}>`, `${active ? 'Ends' : 'Ended'} ${ts(g.ends_at)}`, `Winners: ${g.winners}`, `Entries: ${gwCount(g.id)}`];
  if (g.req_role) lines.push(`Requires <@&${g.req_role}>`);
  if (!active) lines.push(w.length ? `Winner${w.length > 1 ? 's' : ''}: ${w.map((x) => `<@${x}>`).join(' ')}` : 'No valid entries.');
  return embed(cfg, lines.join('\n')).setTitle(g.prize);
}
async function startGiveaway(guild, channel, host, a) {
  const s = getSetting(guild.id, 'giveaways', {});
  const ch = channel || (s.channel && guild.channels.cache.get(s.channel));
  if (!ch) throw new UserError('Choose a channel, or set a default giveaway channel in /setup giveaways.');
  if (a.duration < 10e3 || a.duration > 60 * 864e5) throw new UserError('A giveaway must last between 10 seconds and 60 days.');
  assertCanPost(guild, ch);
  const winners = a.winners || 1;
  const r = db.prepare('INSERT INTO giveaways (guild_id, channel_id, prize, winners, ends_at, host_id, req_role, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(guild.id, ch.id, a.prize, winners, Date.now() + a.duration, host.id, a.role ? a.role.id : null, Date.now());
  const id = Number(r.lastInsertRowid);
  const g = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id);
  const msg = await ch.send({
    content: s.ping_role ? `<@&${s.ping_role}>` : undefined, embeds: [gwEmbed(getConfig(guild.id), g)],
    components: [actionRow(button(`gw:enter:${id}`, 'Enter or leave', ButtonStyle.Primary))], allowedMentions: { roles: s.ping_role ? [s.ping_role] : [] },
  });
  db.prepare('UPDATE giveaways SET message_id = ? WHERE id = ?').run(msg.id, id);
  return { id, ch };
}
async function drawWinners(guild, id, n, exclude) {
  const pool = shuffle(db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?').all(id).map((r) => r.user_id).filter((u) => !exclude.includes(u)));
  const out = [];
  for (const uid of pool) {
    if (out.length >= n) break;
    const m = await guild.members.fetch(uid).catch(() => null);
    if (m && !m.user.bot) out.push(uid);
  }
  return out;
}
async function endGiveaway(guild, id, { reroll = false, count } = {}) {
  const g = db.prepare('SELECT * FROM giveaways WHERE id = ? AND guild_id = ?').get(id, guild.id);
  if (!g) throw new UserError('That giveaway does not exist.');
  if (!reroll && g.status !== 'active') throw new UserError('That giveaway has already ended.');
  if (reroll && g.status === 'active') throw new UserError('That giveaway is still running. End it first.');
  const prev = JSON.parse(g.winner_ids || '[]');
  const winners = await drawWinners(guild, id, count || g.winners, reroll ? prev : []);
  db.prepare("UPDATE giveaways SET status = 'ended', winner_ids = ? WHERE id = ?").run(JSON.stringify(winners), id);
  g.status = 'ended'; g.winner_ids = JSON.stringify(winners);
  const ch = guild.channels.cache.get(g.channel_id);
  if (ch) {
    const msg = g.message_id ? await ch.messages.fetch(g.message_id).catch(() => null) : null;
    if (msg) await msg.edit({ embeds: [gwEmbed(getConfig(guild.id), g)], components: [] }).catch(() => {});
    await ch.send({ content: winners.length ? `${winners.map((x) => `<@${x}>`).join(' ')} won **${g.prize}**.` : `No valid entries for **${g.prize}**.`,
      allowedMentions: { users: winners }, ...(msg ? { reply: { messageReference: msg.id, failIfNotExists: false } } : {}) }).catch(() => {});
  }
  if (getSetting(guild.id, 'giveaways', {}).dm_winners !== false) {
    for (const uid of winners) {
      const u = await client.users.fetch(uid).catch(() => null);
      if (u) u.send({ embeds: [embed(getConfig(guild.id), `You won **${g.prize}** in ${guild.name}.`)] }).catch(() => {});
    }
  }
  return winners;
}
route('gw', async (i, p) => {
  const g = db.prepare('SELECT * FROM giveaways WHERE id = ? AND guild_id = ?').get(Number(p[2]), i.guild.id);
  if (!g || g.status !== 'active') throw new UserError('This giveaway has ended.');
  if (g.req_role && !i.member.roles.cache.has(g.req_role)) throw new UserError(`You need the <@&${g.req_role}> role to enter.`);
  const has = db.prepare('SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?').get(g.id, i.user.id);
  if (has) db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?').run(g.id, i.user.id);
  else db.prepare('INSERT INTO giveaway_entries (giveaway_id, user_id) VALUES (?,?)').run(g.id, i.user.id);
  await i.update({ embeds: [gwEmbed(getConfig(i.guild.id), g)] });
  await i.followUp({ embeds: [embed(getConfig(i.guild.id), has ? 'You left the giveaway.' : 'You are entered. Good luck.')], flags: MessageFlags.Ephemeral });
});
onTick(async () => {
  for (const g of db.prepare("SELECT * FROM giveaways WHERE status = 'active' AND ends_at <= ?").all(Date.now())) {
    const guild = client.guilds.cache.get(g.guild_id);
    if (guild) await endGiveaway(guild, g.id).catch((e) => console.error('Giveaway end failed:', e.message));
  }
});
define({
  name: 'giveaway', description: 'Run giveaways', category: 'Events', perm: P.ManageGuild,
  subs: {
    start: {
      description: 'Start a giveaway',
      options: [opt('duration', 'duration', 'How long it runs (for example 1h, 2d)', true), opt('string', 'prize', 'The prize', true, { rest: true, maxLength: 200 }),
        opt('int', 'winners', 'Number of winners (default 1)', false, { min: 1, max: 20 }), opt('role', 'role', 'Role required to enter'), opt('channel', 'channel', 'Channel (default from /setup giveaways)')],
      async run(ctx, a) {
        const { id, ch } = await startGiveaway(ctx.guild, a.channel, ctx.user, a);
        await ctx.ok(`Giveaway #${id} started in <#${ch.id}>.`);
      },
    },
    end: {
      description: 'End a giveaway now', options: [opt('int', 'id', 'Giveaway number', true, { min: 1 })],
      async run(ctx, a) { await ctx.defer(); const w = await endGiveaway(ctx.guild, a.id); await ctx.ok(w.length ? `Giveaway #${a.id} ended. ${w.length} winner${w.length > 1 ? 's' : ''} chosen.` : `Giveaway #${a.id} ended with no valid entries.`); },
    },
    reroll: {
      description: 'Pick new winners', options: [opt('int', 'id', 'Giveaway number', true, { min: 1 }), opt('int', 'count', 'How many to pick', false, { min: 1, max: 20 })],
      async run(ctx, a) { await ctx.defer(); const w = await endGiveaway(ctx.guild, a.id, { reroll: true, count: a.count }); await ctx.ok(w.length ? `New winner${w.length > 1 ? 's' : ''}: ${w.map((x) => `<@${x}>`).join(' ')}` : 'There were no other valid entries to pick from.'); },
    },
    list: {
      description: 'List running giveaways',
      async run(ctx) {
        const rows = db.prepare("SELECT * FROM giveaways WHERE guild_id = ? AND status = 'active' ORDER BY ends_at").all(ctx.guild.id);
        await ctx.ok(rows.length ? rows.map((g) => `**#${g.id}** ${clip(g.prize, 60)} · ${gwCount(g.id)} entries · ends ${ts(g.ends_at)} in <#${g.channel_id}>`).join('\n') : 'No giveaways are running.');
      },
    },
  },
});

// Events
const EVENT_KINDS = ['event', 'trivia', 'competition'];
FORMS.event = (i) => makeModal(`ev:new:${i.channelId}`, 'Create an event', [
  textInput('title', 'Title', { required: true, max: 100 }), textInput('description', 'Description (optional)', { long: true, max: 1000 }),
  textInput('when', 'Starts in (2h) or at (2026-12-01 20:00 UTC)', { required: true, max: 20 }),
  textInput('kind', 'Type: event, trivia or competition', { max: 12, value: 'event' }),
]);
FORMS.triviaadd = () => makeModal('ev:tadd', 'Add a trivia question', [
  textInput('question', 'Question', { long: true, required: true, max: 300 }), textInput('answer', 'Answer', { required: true, max: 100 }),
  textInput('alts', 'Other accepted answers, comma separated', { max: 200 }),
]);
const evCount = (id) => db.prepare('SELECT COUNT(*) n FROM event_joins WHERE event_id = ?').get(id).n;
function eventEmbed(cfg, ev) {
  const e = embed(cfg).setTitle(ev.title).addFields({ name: 'Starts', value: `${ts(ev.starts_at, 'f')} · ${ts(ev.starts_at)}`, inline: true },
    { name: 'Type', value: capital(ev.kind), inline: true }, { name: 'Joined', value: String(evCount(ev.id)), inline: true });
  if (ev.description) e.setDescription(ev.description);
  if (ev.status !== 'scheduled') e.setFooter({ text: `${FOOTER} · ${capital(ev.status)}` });
  return e;
}
route('ev', async (i, p) => {
  const g = i.guild, cfg = getConfig(g.id);
  if (p[1] === 'new') {
    if (!i.memberPermissions.has(P.ManageEvents) && !i.memberPermissions.has(P.ManageGuild)) throw new UserError('You cannot create events.');
    const starts = parseWhen(i.fields.getTextInputValue('when'));
    if (!starts || starts <= Date.now()) throw new UserError(`That start time is not valid. ${WHEN_HELP}`);
    const kind = (i.fields.getTextInputValue('kind').trim() || 'event').toLowerCase();
    if (!EVENT_KINDS.includes(kind)) throw new UserError('Type must be event, trivia or competition.');
    const s = getSetting(g.id, 'events', {});
    const ch = (s.channel && g.channels.cache.get(s.channel)) || g.channels.cache.get(p[2]);
    if (!ch) throw new UserError('I cannot find a channel to post in. Set one in /setup events.');
    assertCanPost(g, ch);
    const r = db.prepare('INSERT INTO events (guild_id, title, description, kind, starts_at, channel_id, creator_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(g.id, i.fields.getTextInputValue('title').trim(), i.fields.getTextInputValue('description').trim(), kind, starts, ch.id, i.user.id, Date.now());
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(r.lastInsertRowid));
    const msg = await ch.send({ content: s.ping_role ? `<@&${s.ping_role}>` : undefined, embeds: [eventEmbed(cfg, ev)],
      components: [actionRow(button(`ev:join:${ev.id}`, 'Join or leave', ButtonStyle.Primary))], allowedMentions: { roles: s.ping_role ? [s.ping_role] : [] } });
    db.prepare('UPDATE events SET message_id = ? WHERE id = ?').run(msg.id, ev.id);
    return i.reply({ embeds: [embed(cfg, `Event #${ev.id} created in <#${ch.id}>.`)], flags: MessageFlags.Ephemeral });
  }
  if (p[1] === 'tadd') {
    if (!i.memberPermissions.has(P.ManageGuild)) throw new UserError('You cannot add trivia questions.');
    db.prepare('INSERT INTO trivia_bank (guild_id, question, answer, alts) VALUES (?,?,?,?)').run(g.id, i.fields.getTextInputValue('question').trim(), i.fields.getTextInputValue('answer').trim(), i.fields.getTextInputValue('alts').trim());
    return i.reply({ embeds: [embed(cfg, 'Question added to the trivia bank.')], flags: MessageFlags.Ephemeral });
  }
  if (p[1] === 'join') {
    const ev = db.prepare('SELECT * FROM events WHERE id = ? AND guild_id = ?').get(Number(p[2]), g.id);
    if (!ev || ev.status !== 'scheduled') throw new UserError('This event is no longer open for joining.');
    const has = db.prepare('SELECT 1 FROM event_joins WHERE event_id = ? AND user_id = ?').get(ev.id, i.user.id);
    if (has) db.prepare('DELETE FROM event_joins WHERE event_id = ? AND user_id = ?').run(ev.id, i.user.id);
    else db.prepare('INSERT INTO event_joins (event_id, user_id, at) VALUES (?,?,?)').run(ev.id, i.user.id, Date.now());
    await i.update({ embeds: [eventEmbed(cfg, ev)] });
    return i.followUp({ embeds: [embed(cfg, has ? 'You left the event.' : 'You joined. You will be pinged before it starts.')], flags: MessageFlags.Ephemeral });
  }
  return undefined;
});
define({
  name: 'event', description: 'Schedule and manage events', category: 'Events', perm: P.ManageEvents,
  subs: {
    create: { description: 'Create an event, trivia night or competition', run: (ctx) => openForm(ctx, 'event', '0', 'Create event') },
    cancel: {
      description: 'Cancel an event', options: [opt('int', 'id', 'Event number', true, { min: 1 })],
      async run(ctx, a) {
        const ev = db.prepare('SELECT * FROM events WHERE id = ? AND guild_id = ?').get(a.id, ctx.guild.id);
        if (!ev || ev.status !== 'scheduled') throw new UserError('That event is not scheduled.');
        db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(ev.id);
        ev.status = 'cancelled';
        const ch = ctx.guild.channels.cache.get(ev.channel_id), msg = ch && ev.message_id ? await ch.messages.fetch(ev.message_id).catch(() => null) : null;
        if (msg) await msg.edit({ embeds: [eventEmbed(ctx.cfg, ev)], components: [] }).catch(() => {});
        await ctx.ok(`Event #${ev.id} was cancelled.`);
      },
    },
    list: {
      description: 'List upcoming events',
      async run(ctx) {
        const rows = db.prepare("SELECT * FROM events WHERE guild_id = ? AND status = 'scheduled' ORDER BY starts_at LIMIT 15").all(ctx.guild.id);
        await ctx.ok(rows.length ? rows.map((e) => `**#${e.id}** ${clip(e.title, 60)} · ${capital(e.kind)} · ${ts(e.starts_at)} · ${evCount(e.id)} joined`).join('\n') : 'No events are scheduled.');
      },
    },
    participants: {
      description: 'See who joined an event', options: [opt('int', 'id', 'Event number', true, { min: 1 })],
      async run(ctx, a) {
        const ev = db.prepare('SELECT * FROM events WHERE id = ? AND guild_id = ?').get(a.id, ctx.guild.id);
        if (!ev) throw new UserError('That event does not exist.');
        const rows = db.prepare('SELECT user_id FROM event_joins WHERE event_id = ? ORDER BY at LIMIT 60').all(ev.id);
        await ctx.ok(rows.length ? `**${ev.title}** · ${evCount(ev.id)} joined\n${rows.map((r) => `<@${r.user_id}>`).join(' ')}` : 'Nobody has joined yet.');
      },
    },
  },
});
onTick(async () => {
  const now = Date.now();
  for (const ev of db.prepare("SELECT * FROM events WHERE status = 'scheduled' AND starts_at <= ?").all(now + 864e5 + 60e3)) {
    const g = client.guilds.cache.get(ev.guild_id), ch = g && g.channels.cache.get(ev.channel_id);
    if (!g || !ch) continue;
    const s = getSetting(g.id, 'events', {});
    const lead = s.reminder === undefined ? 15 * 60e3 : s.reminder;
    const joined = db.prepare('SELECT user_id FROM event_joins WHERE event_id = ? LIMIT 40').all(ev.id).map((r) => r.user_id);
    const mentions = [...(s.ping_role ? [`<@&${s.ping_role}>`] : []), ...joined.map((u) => `<@${u}>`)].join(' ');
    const allowed = { users: joined, roles: s.ping_role ? [s.ping_role] : [] };
    if (ev.starts_at <= now) {
      db.prepare("UPDATE events SET status = 'started', reminded = 1 WHERE id = ?").run(ev.id);
      await ch.send({ content: `${mentions}\n**${ev.title}** is starting now.`.trim(), allowedMentions: allowed }).catch(() => {});
      ev.status = 'started';
      const msg = ev.message_id ? await ch.messages.fetch(ev.message_id).catch(() => null) : null;
      if (msg) await msg.edit({ embeds: [eventEmbed(getConfig(g.id), ev)], components: [] }).catch(() => {});
    } else if (!ev.reminded && ev.starts_at - lead <= now) {
      db.prepare('UPDATE events SET reminded = 1 WHERE id = ?').run(ev.id);
      await ch.send({ content: `${mentions}\n**${ev.title}** starts ${ts(ev.starts_at)}.`.trim(), allowedMentions: allowed }).catch(() => {});
    }
  }
});

// Trivia
const trivia = new Map();
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
function triviaAsk(s) {
  const q = s.qs[s.n];
  s.current = q;
  s.channel.send({ embeds: [embed(getConfig(s.guild.id), clip(q.question, 1500)).setTitle(`Question ${s.n + 1} of ${s.qs.length}`).setFooter({ text: `${FOOTER} · ${s.secs} seconds` })] }).catch(() => {});
  s.timer = setTimeout(() => triviaNext(s, null), s.secs * 1000);
}
function triviaNext(s, winner) {
  clearTimeout(s.timer);
  const q = s.current;
  s.current = null;
  s.channel.send({ embeds: [embed(getConfig(s.guild.id), winner ? `<@${winner}> got it. The answer was **${q.answer}**.` : `Time is up. The answer was **${q.answer}**.`)], allowedMentions: { parse: [] } }).catch(() => {});
  s.n += 1;
  if (s.n >= s.qs.length) return triviaFinish(s);
  s.timer = setTimeout(() => triviaAsk(s), 3000);
  return undefined;
}
function triviaFinish(s) {
  clearTimeout(s.timer);
  trivia.delete(s.channel.id);
  const board = [...s.scores.entries()].sort((a, b) => b[1] - a[1]);
  for (const [uid, pts] of board) db.prepare('INSERT INTO trivia_scores (guild_id, user_id, points) VALUES (?,?,?) ON CONFLICT (guild_id, user_id) DO UPDATE SET points = points + excluded.points').run(s.guild.id, uid, pts);
  s.channel.send({ embeds: [embed(getConfig(s.guild.id), board.length ? board.slice(0, 10).map(([u, p], n) => `${n + 1}. <@${u}> · ${p} point${p === 1 ? '' : 's'}`).join('\n') : 'Nobody scored this round.').setTitle('Trivia results')], allowedMentions: { parse: [] } }).catch(() => {});
}
onMessage(async (m) => {
  const s = trivia.get(m.channel.id);
  if (!s || !s.current) return false;
  const guess = norm(m.content);
  const ok = [s.current.answer, ...s.current.alts.split(',')].map(norm).filter(Boolean);
  if (ok.includes(guess)) { s.scores.set(m.author.id, (s.scores.get(m.author.id) || 0) + 1); earn(m.guild.id, m.member, econ(m.guild.id).trivia_coins || 0); triviaNext(s, m.author.id); }
  return false;
});
define({
  name: 'trivia', description: 'Run trivia with your own questions', category: 'Events', perm: P.ManageGuild,
  subs: {
    add: { description: 'Add a question to the bank', run: (ctx) => openForm(ctx, 'triviaadd', '0', 'Add question') },
    list: {
      description: 'List the question bank',
      async run(ctx) {
        const rows = db.prepare('SELECT * FROM trivia_bank WHERE guild_id = ? ORDER BY id LIMIT 25').all(ctx.guild.id);
        await ctx.ok(rows.length ? rows.map((r) => `**#${r.id}** ${clip(r.question, 80)} → ${clip(r.answer, 40)}`).join('\n') : 'The bank is empty. Add questions with /trivia add.');
      },
    },
    remove: {
      description: 'Remove a question', options: [opt('int', 'id', 'Question number', true, { min: 1 })],
      async run(ctx, a) {
        const r = db.prepare('DELETE FROM trivia_bank WHERE id = ? AND guild_id = ?').run(a.id, ctx.guild.id);
        if (!r.changes) throw new UserError('That question does not exist.');
        await ctx.ok(`Question #${a.id} removed.`);
      },
    },
    start: {
      description: 'Start a trivia round in this channel',
      options: [opt('int', 'questions', 'How many questions (default 5)', false, { min: 1, max: 20 }), opt('int', 'seconds', 'Seconds per question (default 20)', false, { min: 10, max: 120 })],
      async run(ctx, a) {
        if (trivia.has(ctx.channel.id)) throw new UserError('A round is already running here.');
        const bank = db.prepare('SELECT * FROM trivia_bank WHERE guild_id = ?').all(ctx.guild.id);
        if (!bank.length) throw new UserError('The trivia bank is empty. Add questions with /trivia add first.');
        const s = { guild: ctx.guild, channel: ctx.channel, qs: shuffle(bank).slice(0, a.questions || 5), n: 0, secs: a.seconds || 20, scores: new Map(), current: null, timer: null };
        trivia.set(ctx.channel.id, s);
        await ctx.ok(`Trivia starts now with ${s.qs.length} question${s.qs.length === 1 ? '' : 's'}. Type your answers in this channel.`);
        triviaAsk(s);
      },
    },
    stop: {
      description: 'Stop the running round',
      async run(ctx) {
        const s = trivia.get(ctx.channel.id);
        if (!s) throw new UserError('No round is running here.');
        triviaFinish(s);
        await ctx.ok('The round was stopped.');
      },
    },
    scores: {
      description: 'Show the all-time trivia leaderboard',
      async run(ctx) {
        const rows = db.prepare('SELECT * FROM trivia_scores WHERE guild_id = ? ORDER BY points DESC LIMIT 10').all(ctx.guild.id);
        await ctx.ok(rows.length ? rows.map((r, n) => `${n + 1}. <@${r.user_id}> · ${r.points}`).join('\n') : 'No scores yet.');
      },
    },
  },
});


/* ------------------------ 7h. COMMUNITY FEATURES ------------------------- */
const WYR_BANK = [
  'Always know the right answer|Always ask the right question', 'Live in a library|Live in an observatory', 'Speak every language|Talk to every animal',
  'Have a pet dragon the size of a cat|Have a cat the size of a dragon', 'Never feel cold|Never feel tired', 'Find a hidden room in your home|Find a hidden path in your town',
  'Visit the past for a day|Glimpse the future for a day', 'Cook perfectly every time|Sing perfectly every time', 'Own a talking raven|Own a map that updates itself',
  'Always arrive early|Never get lost', 'Have endless books|Have endless music', 'Live where it is always autumn|Live where it is always spring',
  'Fly slowly|Run extremely fast', 'Have one door to anywhere each year|Have a pocket that holds anything', 'Forget one bad memory|Relive one good memory',
  'Know every secret in town|Be trusted with a secret by everyone', 'Brew any potion once a day|Cast one spell a week', 'Stargaze every night|Sunbathe every day',
  'Own a lantern that never goes out|Own a quill that never runs dry', 'Be the best at chess|Be the best at riddles', 'Explore a deep cave|Explore a tall tower',
  'Have breakfast for every meal|Have dessert for every meal', 'Have a perfect memory|Have perfect intuition', 'Win by luck|Win by skill', 'Be famous for a day|Be wise for a year',
  'Always speak in rhyme|Always whisper', 'Live in a treehouse|Live in a lighthouse', 'Befriend a ghost|Befriend a giant', 'Swim with whales|Fly with eagles',
  'Pause time for ten seconds|Rewind time ten seconds', 'Learn any skill in a day|Master any craft in a month', 'Always have good weather|Always have good company',
  'Wear robes every day|Wear armor every day', 'Have a sidekick owl|Have a sidekick fox', 'Have a secret garden|Have a secret tower',
  'Spend a night in an enchanted forest|Spend a night in a haunted castle', 'Receive a mysterious letter every week|Receive a mysterious gift every month',
  'Be able to see in the dark|Be able to hear very far', 'Know every song ever written|Know every story ever told',
];
const TOT_BANK = [
  ['Tea', 'Coffee'], ['Sunrise', 'Sunset'], ['Library', 'Observatory'], ['Cats', 'Owls'], ['Rain', 'Snow'], ['Sword', 'Staff'], ['Map', 'Compass'], ['Candle', 'Lantern'],
  ['Forest', 'Mountains'], ['Day', 'Night'], ['Summer', 'Winter'], ['Books', 'Music'], ['Mystery', 'Adventure'], ['Cake', 'Pie'], ['Sweet', 'Salty'], ['Early bird', 'Night owl'],
  ['Beach', 'Cabin'], ['Dragons', 'Griffins'], ['Potions', 'Spells'], ['Castle', 'Treehouse'], ['Moon', 'Sun'], ['Past', 'Future'], ['Wolf', 'Raven'], ['Quill', 'Typewriter'],
  ['Stars', 'Fireflies'], ['City', 'Countryside'], ['Pancakes', 'Waffles'], ['Crystal ball', 'Tarot cards'], ['Thunderstorm', 'Fog'], ['Silver', 'Gold'], ['Hot chocolate', 'Cider'],
  ['Riddles', 'Puzzles'], ['Autumn', 'Spring'], ['Ink', 'Chalk'], ['Solo quest', 'Party quest'], ['Ancient ruins', 'Hidden village'], ['Bread', 'Cheese'], ['Lake', 'River'],
  ['Fireplace', 'Garden'], ['Cloak', 'Hat'],
];
const DAILYQ_BANK = [
  'What small thing made you smile this week?', 'Which book, film or game would you recommend to everyone here?', 'What is the best meal you have had this month?',
  'If you could learn any skill overnight, what would it be?', 'What is a place you would love to visit someday?', 'What song is stuck in your head right now?',
  'What is something you are looking forward to?', 'What is the most useful thing you have learned recently?', 'Which fictional place would you most like to live in?',
  'What is your favourite way to spend a rainy day?', 'What hobby have you always wanted to try?', 'Which season suits you best, and why?',
  'What is the best piece of advice you have received?', 'What would you name a pet dragon?', 'What is your go-to comfort food?',
  'Which fictional creature would make the best companion?', 'What is a tradition you love?', 'What was your favourite thing to do as a child?',
  'If you could have dinner with anyone from history, who would it be?', 'What is the best gift you have ever given?', 'What is something you are proud of this year?',
  'Which sound do you find most relaxing?', 'What would your ideal day off look like?', 'What is your favourite word, and why?',
  'What is a skill you wish more people had?', 'Which mythical object would you choose to own?', 'What is the most interesting thing you have read lately?',
  'What is your earliest happy memory?', 'What is a goal you are working toward right now?', 'Which room in a house is your favourite?',
  'What do you like most about the place you live?', 'If you could master any instrument, which would you pick?', 'What is the kindest thing someone has done for you?',
  'What is your favourite time of day?', 'What is a question you wish someone would ask you?', 'Which language would you most like to speak?',
  'What is your favourite kind of weather?', 'What makes a good friend, in your opinion?', 'What is the best surprise you have had?',
  'Which spell from a story would you cast first?', 'What is something you have changed your mind about?', 'What is your favourite smell?',
  'If you could redecorate any building, which would it be?', 'What do you do when you cannot sleep?', 'What is a movie you can watch again and again?',
  'What is the best view you have ever seen?', 'Which job would you try for a week?', 'What is a tiny luxury you enjoy?', 'What is a story you love telling?',
  'What is a place that feels magical to you?',
];
const postable = (guild, id) => { const ch = id && guild.channels.cache.get(id); if (!ch) return null; assertCanPost(guild, ch); return ch; };

simpleFeature('anonymous', {
  title: 'Anonymous posts', desc: 'Confessions and anonymous questions with staff oversight',
  blurb: 'Members stay anonymous to everyone but the staff log, which records who sent each post.',
  fields: [
    { k: 'confession_channel', label: 'Confession channel', type: 'channel' },
    { k: 'question_channel', label: 'Question channel', type: 'channel' },
    { k: 'staff_channel', label: 'Staff oversight log', type: 'channel' },
  ],
});
FORMS.confess = () => makeModal('an:c', 'Anonymous confession', [textInput('text', 'Your confession', { long: true, required: true, max: 1500 })]);
FORMS.anonq = () => makeModal('an:q', 'Anonymous question', [textInput('text', 'Your question', { long: true, required: true, max: 1000 })]);
route('an', async (i, p) => {
  const g = i.guild, s = getSetting(g.id, 'anonymous', {}), isC = p[1] === 'c';
  const ch = postable(g, isC ? s.confession_channel : s.question_channel);
  if (!ch) throw new UserError(`${isC ? 'Confessions are' : 'Anonymous questions are'} not set up. An admin can choose a channel in /setup anonymous.`);
  if (!s.staff_channel) throw new UserError('Anonymous posts need a staff oversight channel. An admin can choose one in /setup anonymous.');
  const text = i.fields.getTextInputValue('text').trim();
  const kind = isC ? 'confession' : 'question';
  const n = db.prepare('SELECT COUNT(*) + 1 AS n FROM anon_posts WHERE guild_id = ? AND kind = ?').get(g.id, kind).n;
  const msg = await ch.send({ embeds: [embed(getConfig(g.id), text).setTitle(`${isC ? 'Confession' : 'Anonymous question'} #${n}`)], allowedMentions: { parse: [] } });
  db.prepare('INSERT INTO anon_posts (guild_id, kind, user_id, content, message_id, created_at) VALUES (?,?,?,?,?,?)').run(g.id, kind, i.user.id, text, msg.id, Date.now());
  const log = g.channels.cache.get(s.staff_channel);
  if (log) await log.send({ embeds: [embed(getConfig(g.id)).setTitle(`${isC ? 'Confession' : 'Question'} #${n} · author`).addFields({ name: 'Sent by', value: `<@${i.user.id}> (${i.user.id})` }, { name: 'Content', value: clip(text, 1000) }, { name: 'Message', value: `[Jump](${msg.url || ''})` })], allowedMentions: { parse: [] } }).catch(() => {});
  return i.reply({ embeds: [embed(getConfig(g.id), `Posted anonymously in <#${ch.id}>.`)], flags: MessageFlags.Ephemeral });
});
define({ name: 'confess', description: 'Post an anonymous confession', category: 'Community', run: (ctx) => openForm(ctx, 'confess', '0', 'Write confession') });
define({ name: 'anonquestion', description: 'Ask an anonymous question', category: 'Community', run: (ctx) => openForm(ctx, 'anonq', '0', 'Write question') });

// Suggestions
simpleFeature('suggestions', {
  title: 'Suggestions', desc: 'Where suggestions are posted and who can review them',
  fields: [{ k: 'channel', label: 'Suggestion channel', type: 'channel' }, { k: 'review_role', label: 'Reviewer role', type: 'role' }],
});
const sgVotes = (id) => ({ up: db.prepare('SELECT COUNT(*) n FROM suggestion_votes WHERE suggestion_id = ? AND vote = 1').get(id).n, down: db.prepare('SELECT COUNT(*) n FROM suggestion_votes WHERE suggestion_id = ? AND vote = -1').get(id).n });
const SG_COLOR = { pending: null, approved: 0x4a7c59, denied: 0x8b2f3a };
function sgPayload(cfg, sg) {
  const v = sgVotes(sg.id);
  const e = embed(cfg, sg.content).setTitle(`Suggestion #${sg.id}`).addFields({ name: 'Suggested by', value: `<@${sg.user_id}>`, inline: true }, { name: 'Status', value: capital(sg.status), inline: true });
  if (SG_COLOR[sg.status]) e.setColor(SG_COLOR[sg.status]);
  if (sg.note) e.addFields({ name: 'Staff note', value: clip(sg.note, 500) });
  const off = sg.status !== 'pending';
  return { embeds: [e], components: [actionRow(button(`sg:u:${sg.id}`, `Support (${v.up})`, ButtonStyle.Success, off), button(`sg:d:${sg.id}`, `Oppose (${v.down})`, ButtonStyle.Danger, off))] };
}
route('sg', async (i, p) => {
  const sg = db.prepare('SELECT * FROM suggestions WHERE id = ? AND guild_id = ?').get(Number(p[2]), i.guild.id);
  if (!sg || sg.status !== 'pending') throw new UserError('Voting on this suggestion is closed.');
  const vote = p[1] === 'u' ? 1 : -1;
  const cur = db.prepare('SELECT vote FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?').get(sg.id, i.user.id);
  if (cur && cur.vote === vote) db.prepare('DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?').run(sg.id, i.user.id);
  else db.prepare('INSERT INTO suggestion_votes (suggestion_id, user_id, vote) VALUES (?,?,?) ON CONFLICT (suggestion_id, user_id) DO UPDATE SET vote = excluded.vote').run(sg.id, i.user.id, vote);
  await i.update(sgPayload(getConfig(i.guild.id), sg));
});
define({
  name: 'suggest', description: 'Post a suggestion for the community to vote on', category: 'Community',
  options: [opt('string', 'suggestion', 'Your suggestion', true, { rest: true, maxLength: 1500 })],
  async run(ctx, a) {
    const ch = postable(ctx.guild, getSetting(ctx.guild.id, 'suggestions', {}).channel);
    if (!ch) throw new UserError('Suggestions are not set up. An admin can choose a channel in /setup suggestions.');
    const r = db.prepare('INSERT INTO suggestions (guild_id, user_id, content, created_at) VALUES (?,?,?,?)').run(ctx.guild.id, ctx.user.id, a.suggestion, Date.now());
    const sg = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(Number(r.lastInsertRowid));
    const msg = await ch.send({ ...sgPayload(ctx.cfg, sg), allowedMentions: { parse: [] } });
    db.prepare('UPDATE suggestions SET channel_id = ?, message_id = ? WHERE id = ?').run(ch.id, msg.id, sg.id);
    if (!ctx.isSlash) await ctx.message.delete().catch(() => {});
    await ctx.ok(`Suggestion #${sg.id} posted in <#${ch.id}>.`, { ephemeral: true, deleteAfter: 6000 });
  },
});
async function reviewSuggestion(ctx, a, status) {
  const rr = getSetting(ctx.guild.id, 'suggestions', {}).review_role;
  if (!ctx.member.permissions.has(P.ManageMessages) && !(rr && ctx.member.roles.cache.has(rr))) throw new UserError('You cannot review suggestions.');
  const sg = db.prepare('SELECT * FROM suggestions WHERE id = ? AND guild_id = ?').get(a.id, ctx.guild.id);
  if (!sg) throw new UserError('That suggestion does not exist.');
  db.prepare('UPDATE suggestions SET status = ?, note = ? WHERE id = ?').run(status, a.note || '', sg.id);
  sg.status = status; sg.note = a.note || '';
  const ch = sg.channel_id && ctx.guild.channels.cache.get(sg.channel_id), msg = ch ? await ch.messages.fetch(sg.message_id).catch(() => null) : null;
  if (msg) await msg.edit(sgPayload(ctx.cfg, sg)).catch(() => {});
  await ctx.ok(`Suggestion #${sg.id} ${status}.`);
}
const reviewOpts = [opt('int', 'id', 'Suggestion number', true, { min: 1 }), opt('string', 'note', 'Note for the author', false, { rest: true, maxLength: 500 })];
define({
  name: 'suggestion', description: 'Review suggestions', category: 'Community',
  subs: { approve: { description: 'Approve a suggestion', options: reviewOpts, run: (ctx, a) => reviewSuggestion(ctx, a, 'approved') }, deny: { description: 'Deny a suggestion', options: reviewOpts, run: (ctx, a) => reviewSuggestion(ctx, a, 'denied') } },
});

// Polls, Would You Rather and This or That
const bar = (pct) => '■'.repeat(Math.round(pct / 10)) + '□'.repeat(10 - Math.round(pct / 10));
function pollPayload(cfg, poll) {
  const opts = JSON.parse(poll.options);
  const votes = db.prepare('SELECT choice, COUNT(*) n FROM poll_votes WHERE poll_id = ? GROUP BY choice').all(poll.id);
  const counts = opts.map((_, n) => (votes.find((v) => v.choice === n) || { n: 0 }).n);
  const total = counts.reduce((x, y) => x + y, 0);
  const lines = opts.map((o, n) => `**${n + 1}.** ${o}\n${bar(total ? (counts[n] / total) * 100 : 0)} ${counts[n]} vote${counts[n] === 1 ? '' : 's'}${total ? ` · ${Math.round((counts[n] / total) * 100)}%` : ''}`);
  const title = poll.kind === 'wyr' ? 'Would you rather' : poll.kind === 'tot' ? 'This or that' : poll.question;
  const e = embed(cfg, `${poll.kind === 'poll' ? '' : `${poll.question}\n\n`}${lines.join('\n\n')}`).setTitle(title);
  e.setFooter({ text: `${FOOTER} · ${poll.status === 'closed' ? 'Closed' : poll.ends_at ? `Closes ${new Date(poll.ends_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Open'} · ${total} vote${total === 1 ? '' : 's'}` });
  const rows = [];
  if (poll.status === 'open') {
    for (let k = 0; k < opts.length; k += 5) rows.push(actionRow(...opts.slice(k, k + 5).map((o, n) => button(`pl:v:${poll.id}:${k + n}`, `${k + n + 1}. ${clip(o, 60)}`))));
  }
  return { embeds: [e], components: rows };
}
async function createPoll(guild, channel, user, question, options, endsAt, kind) {
  assertCanPost(guild, channel);
  const r = db.prepare('INSERT INTO polls (guild_id, channel_id, question, options, ends_at, kind, creator_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(guild.id, channel.id, question, JSON.stringify(options), endsAt, kind, user.id, Date.now());
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(Number(r.lastInsertRowid));
  const msg = await channel.send(pollPayload(getConfig(guild.id), poll));
  db.prepare('UPDATE polls SET message_id = ? WHERE id = ?').run(msg.id, poll.id);
  return poll;
}
async function closePoll(guild, poll) {
  db.prepare("UPDATE polls SET status = 'closed' WHERE id = ?").run(poll.id);
  poll.status = 'closed';
  const ch = guild.channels.cache.get(poll.channel_id), msg = ch && poll.message_id ? await ch.messages.fetch(poll.message_id).catch(() => null) : null;
  if (msg) await msg.edit(pollPayload(getConfig(guild.id), poll)).catch(() => {});
}
route('pl', async (i, p) => {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND guild_id = ?').get(Number(p[2]), i.guild.id);
  if (!poll || poll.status !== 'open') throw new UserError('This poll is closed.');
  const choice = Number(p[3]);
  const cur = db.prepare('SELECT choice FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(poll.id, i.user.id);
  if (cur && cur.choice === choice) db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(poll.id, i.user.id);
  else db.prepare('INSERT INTO poll_votes (poll_id, user_id, choice) VALUES (?,?,?) ON CONFLICT (poll_id, user_id) DO UPDATE SET choice = excluded.choice').run(poll.id, i.user.id, choice);
  await i.update(pollPayload(getConfig(i.guild.id), poll));
});
onTick(async () => {
  for (const poll of db.prepare("SELECT * FROM polls WHERE status = 'open' AND ends_at IS NOT NULL AND ends_at <= ?").all(Date.now())) {
    const g = client.guilds.cache.get(poll.guild_id);
    if (g) await closePoll(g, poll);
  }
});
define({
  name: 'poll', description: 'Create and close polls', category: 'Community',
  subs: {
    create: {
      description: 'Create a poll: question | option | option',
      perm: P.ManageMessages,
      options: [opt('string', 'poll', 'Question and options separated by |', true, { rest: true, maxLength: 800 }), opt('duration', 'duration', 'How long the poll runs (optional)')],
      async run(ctx, a) {
        const parts = a.poll.split('|').map((x) => x.trim()).filter(Boolean);
        if (parts.length < 3 || parts.length > 11) throw new UserError('Write the question and 2 to 10 options separated by |, for example: Best season? | Autumn | Winter');
        if (parts.slice(1).some((x) => x.length > 80)) throw new UserError('Options can be at most 80 characters.');
        const poll = await createPoll(ctx.guild, ctx.channel, ctx.user, clip(parts[0], 250), parts.slice(1), a.duration ? Date.now() + a.duration : null, 'poll');
        await ctx.ok(`Poll #${poll.id} created.`, { ephemeral: true, deleteAfter: 5000 });
      },
    },
    end: {
      description: 'Close a poll', perm: P.ManageMessages, options: [opt('int', 'id', 'Poll number', true, { min: 1 })],
      async run(ctx, a) {
        const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND guild_id = ?').get(a.id, ctx.guild.id);
        if (!poll || poll.status !== 'open') throw new UserError('That poll is not open.');
        await closePoll(ctx.guild, poll);
        await ctx.ok(`Poll #${poll.id} closed.`);
      },
    },
  },
});
const pickPrompt = (gid, kind, builtin) => {
  const custom = db.prepare('SELECT text FROM prompts WHERE guild_id = ? AND kind = ?').all(gid, kind).map((r) => r.text);
  return randomOf([...custom, ...builtin]);
};
define({
  name: 'wouldyourather', description: 'Post a Would You Rather poll', category: 'Community',
  async run(ctx) {
    const [a, b] = pickPrompt(ctx.guild.id, 'wouldyourather', WYR_BANK).split('|').map((x) => x.trim());
    await createPoll(ctx.guild, ctx.channel, ctx.user, 'Would you rather...', [a, b], Date.now() + 864e5, 'wyr');
    if (ctx.isSlash) await ctx.ok('Posted.', { ephemeral: true });
  },
});
define({
  name: 'thisorthat', description: 'Post a This or That poll', category: 'Community',
  async run(ctx) {
    const pair = pickPrompt(ctx.guild.id, 'thisorthat', TOT_BANK.map((x) => x.join('|'))).split('|').map((x) => x.trim());
    await createPoll(ctx.guild, ctx.channel, ctx.user, 'Pick one.', pair.slice(0, 2), Date.now() + 864e5, 'tot');
    if (ctx.isSlash) await ctx.ok('Posted.', { ephemeral: true });
  },
});
define({
  name: 'prompt', description: 'Add your own daily questions, would-you-rather and this-or-that prompts', category: 'Community', perm: P.ManageGuild,
  subs: {
    add: {
      description: 'Add a prompt (for A|B kinds separate the two sides with |)',
      options: [opt('string', 'kind', 'Which kind', true, { choices: ['dailyquestion', 'wouldyourather', 'thisorthat'] }), opt('string', 'text', 'The prompt', true, { rest: true, maxLength: 300 })],
      async run(ctx, a) {
        if (a.kind !== 'dailyquestion' && a.text.split('|').filter((x) => x.trim()).length !== 2) throw new UserError('Write exactly two sides separated by |, for example: Tea | Coffee');
        const r = db.prepare('INSERT INTO prompts (guild_id, kind, text) VALUES (?,?,?)').run(ctx.guild.id, a.kind, a.text);
        await ctx.ok(`Added as #${r.lastInsertRowid}.`);
      },
    },
    list: {
      description: 'List your prompts', options: [opt('string', 'kind', 'Which kind', true, { choices: ['dailyquestion', 'wouldyourather', 'thisorthat'] })],
      async run(ctx, a) {
        const rows = db.prepare('SELECT * FROM prompts WHERE guild_id = ? AND kind = ? ORDER BY id LIMIT 25').all(ctx.guild.id, a.kind);
        await ctx.ok(rows.length ? rows.map((r) => `**#${r.id}** ${clip(r.text, 100)}`).join('\n') : 'You have not added any yet. The built-in prompts are used until you do.');
      },
    },
    remove: {
      description: 'Remove a prompt', options: [opt('int', 'id', 'Prompt number', true, { min: 1 })],
      async run(ctx, a) {
        const r = db.prepare('DELETE FROM prompts WHERE id = ? AND guild_id = ?').run(a.id, ctx.guild.id);
        if (!r.changes) throw new UserError('That prompt does not exist.');
        await ctx.ok(`Prompt #${a.id} removed.`);
      },
    },
  },
});

// Daily question and birthdays (run from the tick, once per day at the chosen UTC hour)
simpleFeature('dailyquestion', {
  title: 'Daily question', desc: 'Post a question every day at a time you choose',
  blurb: 'Uses your own prompts first (see /prompt) mixed with the built-in ones.',
  fields: [
    { k: 'enabled', label: 'Enabled', type: 'toggle', def: false }, { k: 'channel', label: 'Channel', type: 'channel' },
    { k: 'hour', label: 'Hour (UTC)', type: 'number', min: 0, max: 23, def: 9, unit: 'UTC' }, { k: 'ping_role', label: 'Ping role', type: 'role' },
  ],
});
async function postDailyQuestion(guild, s) {
  const ch = s.channel && guild.channels.cache.get(s.channel);
  if (!ch) return false;
  const q = pickPrompt(guild.id, 'dailyquestion', DAILYQ_BANK);
  await ch.send({ content: s.ping_role ? `<@&${s.ping_role}>` : undefined, embeds: [embed(getConfig(guild.id), q).setTitle('Question of the day')], allowedMentions: { roles: s.ping_role ? [s.ping_role] : [] } });
  return true;
}
define({
  name: 'dailyquestion', description: 'Post the question of the day now', category: 'Community', perm: P.ManageGuild,
  async run(ctx) {
    const s = getSetting(ctx.guild.id, 'dailyquestion', {});
    if (!(await postDailyQuestion(ctx.guild, s).catch(() => false))) throw new UserError('Choose a channel in /setup dailyquestion first.');
    await ctx.ok('Question posted.', { ephemeral: true });
  },
});
simpleFeature('birthdays', {
  title: 'Birthdays', desc: 'Announce member birthdays and give a birthday role',
  fields: [
    { k: 'enabled', label: 'Enabled', type: 'toggle', def: false }, { k: 'channel', label: 'Announcement channel', type: 'channel' },
    { k: 'role', label: 'Birthday role', type: 'role' }, { k: 'hour', label: 'Hour (UTC)', type: 'number', min: 0, max: 23, def: 8, unit: 'UTC' },
  ],
});
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
define({
  name: 'birthday', description: 'Save and view birthdays', category: 'Community',
  subs: {
    set: {
      description: 'Set your birthday as DD/MM', options: [opt('string', 'date', 'Day and month, for example 24/11', true, { maxLength: 5 })],
      async run(ctx, a) {
        const m = a.date.match(/^(\d{1,2})[/.-](\d{1,2})$/);
        const day = m ? +m[1] : 0, month = m ? +m[2] : 0;
        if (!m || month < 1 || month > 12 || day < 1 || day > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) throw new UserError('Write your birthday as DD/MM, for example 24/11.');
        db.prepare('INSERT INTO birthdays (guild_id, user_id, day, month) VALUES (?,?,?,?) ON CONFLICT (guild_id, user_id) DO UPDATE SET day = excluded.day, month = excluded.month').run(ctx.guild.id, ctx.user.id, day, month);
        await ctx.ok(`Your birthday is saved as ${day} ${MONTHS[month - 1]}.`, { ephemeral: true });
      },
    },
    remove: {
      description: 'Remove your birthday',
      async run(ctx) { db.prepare('DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?').run(ctx.guild.id, ctx.user.id); await ctx.ok('Your birthday was removed.', { ephemeral: true }); },
    },
    list: {
      description: 'List birthdays in a month', options: [opt('int', 'month', 'Month number (default: this month)', false, { min: 1, max: 12 })],
      async run(ctx, a) {
        const month = a.month || new Date().getUTCMonth() + 1;
        const rows = db.prepare('SELECT * FROM birthdays WHERE guild_id = ? AND month = ? ORDER BY day').all(ctx.guild.id, month);
        await ctx.reply({ embeds: [embed(ctx.cfg, rows.length ? rows.map((r) => `${r.day} ${MONTHS[month - 1]} · <@${r.user_id}>`).join('\n') : 'No birthdays saved for this month.').setTitle(`Birthdays · ${MONTHS[month - 1]}`)], allowedMentions: { parse: [] } });
      },
    },
  },
});
onTick(async () => {
  const now = new Date(), day = today(), hour = now.getUTCHours();
  for (const g of client.guilds.cache.values()) {
    const dq = getSetting(g.id, 'dailyquestion', {});
    if (dq.enabled && hour === (dq.hour ?? 9) && getSetting(g.id, 'state_dq', {}).day !== day) {
      putSetting(g.id, 'state_dq', { day });
      await postDailyQuestion(g, dq).catch(() => {});
    }
    const bd = getSetting(g.id, 'birthdays', {});
    if (bd.enabled && hour === (bd.hour ?? 8) && getSetting(g.id, 'state_bd', {}).day !== day) {
      const prev = getSetting(g.id, 'state_bd', {}).holders || [];
      putSetting(g.id, 'state_bd', { day, holders: [] });
      if (bd.role) for (const uid of prev) { const m = await g.members.fetch(uid).catch(() => null); if (m) await m.roles.remove(bd.role, 'Birthday over').catch(() => {}); }
      const rows = db.prepare('SELECT user_id FROM birthdays WHERE guild_id = ? AND month = ? AND day = ?').all(g.id, now.getUTCMonth() + 1, now.getUTCDate());
      const holders = [];
      for (const r of rows) {
        const m = await g.members.fetch(r.user_id).catch(() => null);
        if (!m) continue;
        holders.push(m.id);
        if (bd.role) await m.roles.add(bd.role, 'Birthday').catch(() => {});
      }
      putSetting(g.id, 'state_bd', { day, holders });
      const ch = bd.channel && g.channels.cache.get(bd.channel);
      if (ch && holders.length) await ch.send({ embeds: [embed(getConfig(g.id), `Happy birthday ${holders.map((u) => `<@${u}>`).join(', ')}.`).setTitle('Birthdays today')], allowedMentions: { users: holders } }).catch(() => {});
    }
  }
});

// Awards and Member of the Month
simpleFeature('awards', {
  title: 'Awards', desc: 'Where community awards are announced',
  fields: [{ k: 'channel', label: 'Awards channel', type: 'channel' }],
});
simpleFeature('memberofthemonth', {
  title: 'Member of the Month', desc: 'The role and channel for the monthly spotlight',
  blurb: 'Choose each month\'s member with /memberofthemonth set. The previous holder loses the role automatically.',
  fields: [{ k: 'role', label: 'Member of the Month role', type: 'role' }, { k: 'channel', label: 'Announcement channel', type: 'channel' }],
});
define({
  name: 'award', description: 'Give a community award: title | reason', category: 'Community', perm: P.ManageMessages,
  options: [opt('user', 'member', 'Who receives it', true), opt('string', 'award', 'Award title, then | and an optional reason', true, { rest: true, maxLength: 400 })],
  async run(ctx, a) {
    const [title, ...rest] = a.award.split('|').map((x) => x.trim());
    if (!title) throw new UserError('Write the award title.');
    db.prepare('INSERT INTO awards (guild_id, user_id, title, reason, by_id, at) VALUES (?,?,?,?,?,?)').run(ctx.guild.id, a.member.id, clip(title, 100), rest.join(' | '), ctx.user.id, Date.now());
    const ch = ctx.guild.channels.cache.get(getSetting(ctx.guild.id, 'awards', {}).channel);
    const e = embed(ctx.cfg).setTitle(clip(title, 100)).setDescription(`Awarded to <@${a.member.id}>${rest.length ? `\n\n${rest.join(' | ')}` : ''}`).setThumbnail(a.member.displayAvatarURL());
    if (ch) await ch.send({ embeds: [e], allowedMentions: { users: [a.member.id] } }).catch(() => {});
    await ctx.ok(`Award given to <@${a.member.id}>${ch ? ` and announced in <#${ch.id}>` : ''}.`);
  },
});
define({
  name: 'awards', description: 'View a member\'s awards', category: 'Community', options: [opt('user', 'member', 'Member (defaults to you)')],
  async run(ctx, a) {
    const u = a.member || ctx.user;
    const rows = db.prepare('SELECT * FROM awards WHERE guild_id = ? AND user_id = ? ORDER BY at DESC LIMIT 20').all(ctx.guild.id, u.id);
    await ctx.reply({ embeds: [embed(ctx.cfg, rows.length ? rows.map((r) => `**${r.title}** · ${ts(r.at, 'D')}${r.reason ? `\n${clip(r.reason, 150)}` : ''}`).join('\n\n') : 'No awards yet.').setTitle(`Awards · ${u.username}`)] });
  },
});
define({
  name: 'memberofthemonth', description: 'Set or view the Member of the Month', category: 'Community',
  subs: {
    set: {
      description: 'Choose this month\'s Member of the Month', perm: P.ManageGuild,
      options: [opt('user', 'member', 'Member', true), opt('string', 'reason', 'Why they were chosen', false, { rest: true, maxLength: 500 })],
      async run(ctx, a) {
        const month = new Date().toISOString().slice(0, 7), aw = getSetting(ctx.guild.id, 'awards', {}), mm = getSetting(ctx.guild.id, 'memberofthemonth', {});
        const s = { motm_role: mm.role || aw.motm_role, channel: mm.channel || aw.channel };
        const prev = db.prepare('SELECT user_id FROM motm WHERE guild_id = ? AND month <> ? ORDER BY month DESC LIMIT 1').get(ctx.guild.id, month);
        const cur = db.prepare('SELECT user_id FROM motm WHERE guild_id = ? AND month = ?').get(ctx.guild.id, month);
        db.prepare('INSERT INTO motm (guild_id, month, user_id, reason, by_id) VALUES (?,?,?,?,?) ON CONFLICT (guild_id, month) DO UPDATE SET user_id = excluded.user_id, reason = excluded.reason, by_id = excluded.by_id')
          .run(ctx.guild.id, month, a.member.id, a.reason || '', ctx.user.id);
        if (s.motm_role) {
          for (const uid of new Set([prev && prev.user_id, cur && cur.user_id].filter(Boolean))) { const m = await ctx.guild.members.fetch(uid).catch(() => null); if (m && uid !== a.member.id) await m.roles.remove(s.motm_role).catch(() => {}); }
          const m = await ctx.guild.members.fetch(a.member.id).catch(() => null);
          if (m) await m.roles.add(s.motm_role).catch(() => {});
        }
        const ch = s.channel && ctx.guild.channels.cache.get(s.channel);
        if (ch) await ch.send({ embeds: [embed(ctx.cfg).setTitle(`Member of the Month · ${MONTHS[new Date().getUTCMonth()]}`).setDescription(`<@${a.member.id}>${a.reason ? `\n\n${a.reason}` : ''}`).setThumbnail(a.member.displayAvatarURL())], allowedMentions: { users: [a.member.id] } }).catch(() => {});
        await ctx.ok(`<@${a.member.id}> is Member of the Month.`);
      },
    },
    show: {
      description: 'Show the current Member of the Month',
      async run(ctx) {
        const row = db.prepare('SELECT * FROM motm WHERE guild_id = ? ORDER BY month DESC LIMIT 1').get(ctx.guild.id);
        if (!row) throw new UserError('Nobody has been chosen yet.');
        await ctx.reply({ embeds: [embed(ctx.cfg, `<@${row.user_id}>${row.reason ? `\n\n${row.reason}` : ''}`).setTitle(`Member of the Month · ${row.month}`)], allowedMentions: { parse: [] } });
      },
    },
  },
});

// Member count and server statistics
simpleFeature('membercount', {
  title: 'Member count', desc: 'Keep a channel name updated with the member count',
  blurb: 'Discord limits channel renames, so the name updates at most every few minutes.',
  fields: [
    { k: 'enabled', label: 'Enabled', type: 'toggle', def: false },
    { k: 'channel', label: 'Channel to rename', type: 'channel', types: [ChannelType.GuildVoice, ChannelType.GuildText, ChannelType.GuildAnnouncement], post: false },
    { k: 'format', label: 'Name format', type: 'text', def: 'Members: {count}', max: 60, hint: 'Use {count} for the number' },
  ],
});
const lastCount = new Map();
onTick(async () => {
  for (const g of client.guilds.cache.values()) {
    const s = getSetting(g.id, 'membercount', {});
    if (!s.enabled || !s.channel || Date.now() - (lastCount.get(g.id) || 0) < 6 * 60e3) continue;
    const ch = g.channels.cache.get(s.channel);
    if (!ch) continue;
    const name = (s.format || 'Members: {count}').replaceAll('{count}', String(g.memberCount)).slice(0, 100);
    lastCount.set(g.id, Date.now());
    if (ch.name !== name) await ch.setName(name, 'Member count').catch(() => {});
  }
});
const bump = (gid, col) => db.prepare(`INSERT INTO activity (guild_id, day, ${col}) VALUES (?,?,1) ON CONFLICT (guild_id, day) DO UPDATE SET ${col} = ${col} + 1`).run(gid, today());
onMessage(async (m) => { bump(m.guild.id, 'msgs'); return false; });
client.on(Events.GuildMemberAdd, (m) => { try { bump(m.guild.id, 'joins'); } catch (e) { console.error(e); } });
client.on(Events.GuildMemberRemove, (m) => { try { bump(m.guild.id, 'leaves'); } catch (e) { console.error(e); } });
define({
  name: 'stats', description: 'Server activity for the last 7 days', category: 'Utility',
  async run(ctx) {
    const rows = db.prepare('SELECT * FROM activity WHERE guild_id = ? AND day >= ? ORDER BY day').all(ctx.guild.id, daysAgo(6));
    const max = Math.max(1, ...rows.map((r) => r.msgs));
    const sum = (k) => rows.reduce((x, r) => x + r[k], 0);
    const e = embed(ctx.cfg).setTitle(`${ctx.guild.name} · last 7 days`).addFields(
      { name: 'Members', value: String(ctx.guild.memberCount), inline: true }, { name: 'Messages', value: String(sum('msgs')), inline: true },
      { name: 'Joined / left', value: `${sum('joins')} / ${sum('leaves')}`, inline: true },
      { name: 'Messages per day', value: rows.length ? rows.map((r) => `\`${r.day.slice(5)}\` ${bar((r.msgs / max) * 100)} ${r.msgs}`).join('\n') : 'No data yet. Statistics start from now.' });
    await ctx.reply({ embeds: [e] });
  },
});

// Verification
simpleFeature('verification', {
  title: 'Verification', desc: 'A verify button with role and account age checks',
  fields: [
    { k: 'channel', label: 'Verify channel', type: 'channel' }, { k: 'verified_role', label: 'Verified role', type: 'role' },
    { k: 'unverified_role', label: 'Unverified role (removed)', type: 'role' }, { k: 'min_age', label: 'Minimum account age', type: 'number', min: 0, max: 365, def: 0, unit: 'days' },
    { k: 'log_channel', label: 'Verification log', type: 'channel' }, { k: 'message', label: 'Panel message', type: 'text', max: 500, hint: 'Text shown above the button' },
  ],
  actions: [{
    k: 'post', label: 'Post verify panel', style: ButtonStyle.Primary,
    async run(i, g, s) {
      if (!s.verified_role) throw new UserError('Choose the verified role first.');
      const ch = postable(g, s.channel);
      if (!ch) throw new UserError('Choose the verify channel first.');
      const role = g.roles.cache.get(s.verified_role);
      if (!role || role.managed || role.position >= g.members.me.roles.highest.position) throw new UserError('I cannot give out the verified role. Move my role above it.');
      await ch.send({ embeds: [embed(getConfig(g.id), s.message || 'Press the button to verify and gain access to the server.').setTitle('Verification')], components: [actionRow(button('vf:go', 'Verify', ButtonStyle.Success))] });
      return `Verify panel posted in <#${ch.id}>.`;
    },
  }],
});
route('vf', async (i) => {
  const g = i.guild, s = getSetting(g.id, 'verification', {});
  if (!s.verified_role) throw new UserError('Verification is not set up.');
  if (i.member.roles.cache.has(s.verified_role)) throw new UserError('You are already verified.');
  const need = (s.min_age || 0) * 864e5, age = Date.now() - i.user.createdTimestamp;
  if (age < need) throw new UserError(`Your account is too new to verify. Try again in ${fmtDuration(need - age)}.`);
  await i.member.roles.add(s.verified_role, 'Verified');
  if (s.unverified_role) await i.member.roles.remove(s.unverified_role, 'Verified').catch(() => {});
  db.prepare('INSERT INTO verifications (guild_id, user_id, at) VALUES (?,?,?) ON CONFLICT (guild_id, user_id) DO UPDATE SET at = excluded.at').run(g.id, i.user.id, Date.now());
  const log = s.log_channel && g.channels.cache.get(s.log_channel);
  if (log) log.send({ embeds: [embed(getConfig(g.id), `<@${i.user.id}> verified. Account created ${ts(i.user.createdTimestamp)}.`)], allowedMentions: { parse: [] } }).catch(() => {});
  return i.reply({ embeds: [embed(getConfig(g.id), 'You are verified. Welcome.')], flags: MessageFlags.Ephemeral });
});


/* --------------------- 7i. ROLE MENUS AND AUTOMOD ------------------------ */
const MENU_KINDS = ['buttons', 'select', 'reactions'];
const menuRoles = (m) => { try { return JSON.parse(m.roles); } catch { return []; } };
const getMenu = (id, gid) => db.prepare('SELECT * FROM role_menus WHERE id = ? AND guild_id = ?').get(id, gid);
function parseEmoji(str) {
  const t = (str || '').trim();
  if (!t) return null;
  const c = t.match(/^<(a?):(\w+):(\d+)>$/);
  if (c) return { name: c[2], id: c[3], animated: !!c[1], raw: t };
  if (/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*$/u.test(t)) return { name: t, raw: t };
  throw new UserError('That emoji is not valid. Use a standard emoji or a custom emoji from this server.');
}
const emojiKey = (e) => (e.id ? e.id : e.name);
function menuHome(guild, viewer) {
  const menus = db.prepare('SELECT * FROM role_menus WHERE guild_id = ? ORDER BY id').all(guild.id);
  const e = panelEmbed(guild, 'Setup · Role menus').setDescription(menus.length
    ? menus.map((m) => `**${m.name}** · ${m.kind} · ${menuRoles(m).length} role${menuRoles(m).length === 1 ? '' : 's'}${m.message_id ? '' : ' · not published'}`).join('\n')
    : 'No role menus yet. Create one, choose its roles, then publish it in a channel.');
  const rows = [];
  if (menus.length) rows.push(actionRow(new StringSelectMenuBuilder().setCustomId(sid(viewer, 'rolemenus', 'open')).setPlaceholder('Open a menu').addOptions(menus.slice(0, 25).map((m) => ({ label: clip(m.name, 100), value: String(m.id) })))));
  rows.push(actionRow(button(sid(viewer, 'rolemenus', 'new'), 'New menu', ButtonStyle.Primary, menus.length >= 25), backButton(viewer)));
  return { embeds: [e], components: rows };
}
function menuPanel(guild, viewer, id) {
  const m = getMenu(id, guild.id);
  if (!m) throw new UserError('That menu no longer exists.');
  const roles = menuRoles(m);
  const e = panelEmbed(guild, `Role menu · ${m.name}`).setDescription(m.description || 'No description set.').addFields(
    { name: 'Style', value: capital(m.kind), inline: true }, { name: 'Published in', value: m.channel_id ? `<#${m.channel_id}>` : 'Not published', inline: true },
    { name: 'Roles', value: roles.length ? roles.map((r) => `${r.emoji ? `${r.emoji} ` : ''}${r.label} · <@&${r.role}>`).join('\n') : 'None yet. Pick a role below to add it.' });
  const rows = [actionRow(new RoleSelectMenuBuilder().setCustomId(sid(viewer, 'rolemenus', 'addrole', id)).setPlaceholder('Add a role').setMinValues(1).setMaxValues(1))];
  if (roles.length) rows.push(actionRow(new StringSelectMenuBuilder().setCustomId(sid(viewer, 'rolemenus', 'rmrole', id)).setPlaceholder('Remove a role').addOptions(roles.slice(0, 25).map((r) => ({ label: clip(r.label, 100), value: r.role })))));
  rows.push(actionRow(channelSelect(sid(viewer, 'rolemenus', 'pub', id), 'Publish the menu in a channel')));
  rows.push(actionRow(button(sid(viewer, 'rolemenus', 'detail', id), 'Details', ButtonStyle.Primary), button(sid(viewer, 'rolemenus', 'del', id), 'Delete', ButtonStyle.Danger), button(sid(viewer, 'rolemenus', 'home'), 'Back')));
  return { embeds: [e], components: rows };
}
async function publishMenu(guild, m, ch) {
  const roles = menuRoles(m);
  if (!roles.length) throw new UserError('Add at least one role first.');
  assertCanPost(guild, ch);
  const e = embed(getConfig(guild.id), `${m.description ? `${m.description}\n\n` : ''}${roles.map((r) => `${r.emoji ? `${r.emoji} ` : ''}**${r.label}**`).join('\n')}`).setTitle(m.name);
  let components = [];
  if (m.kind === 'buttons') {
    for (let k = 0; k < roles.length; k += 5) {
      components.push(actionRow(...roles.slice(k, k + 5).map((r) => {
        const b = button(`rm:b:${m.id}:${r.role}`, clip(r.label, 80));
        if (r.emoji) b.setEmoji(parseEmoji(r.emoji));
        return b;
      })));
    }
  } else if (m.kind === 'select') {
    components = [actionRow(new StringSelectMenuBuilder().setCustomId(`rm:s:${m.id}`).setPlaceholder('Choose your roles').setMinValues(0).setMaxValues(roles.length)
      .addOptions(roles.map((r) => { const o = { label: clip(r.label, 100), value: r.role }; if (r.emoji) { const x = parseEmoji(r.emoji); o.emoji = x.id ? { id: x.id, name: x.name, animated: x.animated } : { name: x.name }; } return o; })))];
  }
  const msg = await ch.send({ embeds: [e], components });
  if (m.kind === 'reactions') for (const r of roles) await msg.react(r.emoji).catch(() => {});
  if (m.channel_id && m.message_id) { const old = guild.channels.cache.get(m.channel_id); if (old) old.messages.delete(m.message_id).catch(() => {}); }
  db.prepare('UPDATE role_menus SET channel_id = ?, message_id = ? WHERE id = ?').run(ch.id, msg.id, m.id);
}
registerFeature('rolemenus', {
  desc: 'Button, select-menu and reaction role menus',
  status: (gid) => { const n = db.prepare('SELECT COUNT(*) n FROM role_menus WHERE guild_id = ?').get(gid).n; return n ? `${n} menu${n === 1 ? '' : 's'}` : 'None'; },
  render: (guild, viewer, arg) => (arg ? menuPanel(guild, viewer, Number(arg)) : menuHome(guild, viewer)),
  async onComponent(i, action, args) {
    const g = i.guild, v = i.user.id;
    const show = (arg) => i.update(arg ? menuPanel(g, v, Number(arg)) : menuHome(g, v));
    if (action === 'home') return show();
    if (action === 'new') {
      return i.showModal(makeModal(mid(v, 'rolemenus', 'new'), 'New role menu', [textInput('name', 'Name', { required: true, max: 60 }), textInput('description', 'Description (optional)', { long: true, max: 300 }),
        textInput('kind', 'Style: buttons, select or reactions', { required: true, max: 10, value: 'buttons' })]));
    }
    const id = Number(action === 'open' && i.isStringSelectMenu() ? i.values[0] : args[0]);
    if (action === 'open') return show(id);
    const m = getMenu(id, g.id);
    if (!m) throw new UserError('That menu no longer exists.');
    const roles = menuRoles(m);
    switch (action) {
      case 'addrole': {
        const r = g.roles.cache.get(i.values[0]);
        if (!r || r.managed || r.id === g.id) throw new UserError('That role cannot be used in a menu.');
        if (r.position >= g.members.me.roles.highest.position) throw new UserError(`${r.name} is above my highest role, so I could not give it out.`);
        if (roles.some((x) => x.role === r.id)) throw new UserError('That role is already in this menu.');
        if (roles.length >= (m.kind === 'select' ? 25 : 20)) throw new UserError('This menu is full.');
        return i.showModal(makeModal(mid(v, 'rolemenus', 'addrole', id, r.id), 'Add role to menu', [textInput('label', 'Label', { required: true, max: 80, value: r.name }),
          textInput('emoji', m.kind === 'reactions' ? 'Emoji (required)' : 'Emoji (optional)', { max: 40, required: m.kind === 'reactions' })]));
      }
      case 'rmrole': db.prepare('UPDATE role_menus SET roles = ? WHERE id = ?').run(JSON.stringify(roles.filter((x) => x.role !== i.values[0])), id); return show(id);
      case 'pub': await publishMenu(g, m, g.channels.cache.get(i.values[0])); return show(id);
      case 'detail': return i.showModal(makeModal(mid(v, 'rolemenus', 'detail', id), 'Menu details', [textInput('name', 'Name', { required: true, max: 60, value: m.name }), textInput('description', 'Description', { long: true, max: 300, value: m.description })]));
      case 'del': return i.update({ embeds: [panelEmbed(g, `Delete ${m.name}?`).setDescription('The menu is removed. A published message stays in the channel but stops working.')],
        components: [actionRow(button(sid(v, 'rolemenus', 'delc', id), 'Delete', ButtonStyle.Danger), button(sid(v, 'rolemenus', 'open', id), 'Cancel'))] });
      case 'delc': db.prepare('DELETE FROM role_menus WHERE id = ?').run(id); return show();
      default: return undefined;
    }
  },
  async onModal(i, action, args) {
    const g = i.guild, v = i.user.id, f = (k) => i.fields.getTextInputValue(k).trim();
    if (action === 'new') {
      const kind = f('kind').toLowerCase();
      if (!MENU_KINDS.includes(kind)) throw new UserError('Style must be buttons, select or reactions.');
      const r = db.prepare('INSERT INTO role_menus (guild_id, name, description, kind) VALUES (?,?,?,?)').run(g.id, f('name'), f('description'), kind);
      return respond(i, menuPanel(g, v, Number(r.lastInsertRowid)));
    }
    const id = Number(args[0]), m = getMenu(id, g.id);
    if (!m) throw new UserError('That menu no longer exists.');
    if (action === 'detail') db.prepare('UPDATE role_menus SET name = ?, description = ? WHERE id = ?').run(f('name'), f('description'), id);
    if (action === 'addrole') {
      const em = parseEmoji(f('emoji'));
      const roles = menuRoles(m);
      if (em && roles.some((x) => x.emoji && parseEmoji(x.emoji) && emojiKey(parseEmoji(x.emoji)) === emojiKey(em))) throw new UserError('That emoji is already used in this menu.');
      roles.push({ role: args[1], label: f('label'), emoji: em ? em.raw : '' });
      db.prepare('UPDATE role_menus SET roles = ? WHERE id = ?').run(JSON.stringify(roles), id);
    }
    return respond(i, menuPanel(g, v, id));
  },
});
async function toggleRole(member, roleId, want) {
  const role = member.guild.roles.cache.get(roleId);
  if (!role || role.managed || role.position >= member.guild.members.me.roles.highest.position) throw new UserError('I cannot manage that role right now.');
  const has = member.roles.cache.has(roleId);
  if (want === undefined) want = !has;
  if (want && !has) await member.roles.add(roleId, 'Role menu');
  if (!want && has) await member.roles.remove(roleId, 'Role menu');
  return { role, added: want && !has, removed: !want && has };
}
route('rm', async (i, p) => {
  const m = getMenu(Number(p[2]), i.guild.id);
  if (!m) throw new UserError('This menu no longer exists.');
  const roles = menuRoles(m);
  if (p[1] === 'b') {
    const r = await toggleRole(i.member, p[3]);
    return i.reply({ embeds: [embed(getConfig(i.guild.id), `${r.added ? 'Added' : 'Removed'} **${r.role.name}**.`)], flags: MessageFlags.Ephemeral });
  }
  const chosen = new Set(i.values), lines = [];
  for (const r of roles) { const x = await toggleRole(i.member, r.role, chosen.has(r.role)).catch(() => null); if (x && x.added) lines.push(`Added **${x.role.name}**`); if (x && x.removed) lines.push(`Removed **${x.role.name}**`); }
  return i.reply({ embeds: [embed(getConfig(i.guild.id), lines.length ? lines.join('\n') : 'No changes.')], flags: MessageFlags.Ephemeral });
});
async function onReaction(reaction, user, add) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  const msg = reaction.message;
  if (!msg || !msg.guildId) return;
  const m = db.prepare("SELECT * FROM role_menus WHERE message_id = ? AND kind = 'reactions'").get(msg.id);
  if (!m) return;
  const key = emojiKey(reaction.emoji);
  const entry = menuRoles(m).find((r) => { try { return emojiKey(parseEmoji(r.emoji)) === key; } catch { return false; } });
  if (!entry) return;
  const guild = client.guilds.cache.get(msg.guildId);
  const member = guild && await guild.members.fetch(user.id).catch(() => null);
  if (member) await toggleRole(member, entry.role, add).catch(() => {});
}
client.on(Events.MessageReactionAdd, (r, u) => onReaction(r, u, true).catch((e) => console.error('Reaction role failed:', e.message)));
client.on(Events.MessageReactionRemove, (r, u) => onReaction(r, u, false).catch((e) => console.error('Reaction role failed:', e.message)));

// Automod
const AM_FILTERS = [['spam', 'Spam: many messages quickly'], ['repeated', 'Repeated messages'], ['mentions', 'Excessive mentions'], ['massmentions', '@everyone and @here'],
  ['links', 'Links'], ['invites', 'Server invites'], ['profanity', 'Word filter (your own list)'], ['caps', 'Excessive capitals']];
const AM_PUNISH = [['delete', 'Delete the message'], ['warn', 'Delete and record a warning'], ['mute', 'Delete and time out for 10 minutes']];
const AM_TH = { spam: 5, spam_secs: 6, mentions: 5, repeat: 3, caps: 70 };
const amSet = (gid) => getSetting(gid, 'automod', {});
function amPanel(guild, viewer) {
  const s = amSet(guild.id), on = new Set(s.filters || []), th = { ...AM_TH, ...(s.th || {}) };
  const e = panelEmbed(guild, 'Setup · Automod').addFields(
    { name: 'Active filters', value: on.size ? AM_FILTERS.filter(([k]) => on.has(k)).map(([, l]) => l).join('\n') : 'None. Choose filters below.' },
    { name: 'When triggered', value: (AM_PUNISH.find(([k]) => k === (s.punish || 'delete')) || AM_PUNISH[0])[1], inline: true },
    { name: 'Limits', value: `${th.spam} messages in ${th.spam_secs}s · ${th.mentions} mentions · ${th.repeat} repeats · ${th.caps}% capitals`, inline: true },
    { name: 'Word list', value: `${(s.words || []).length} word${(s.words || []).length === 1 ? '' : 's'}`, inline: true },
    { name: 'Skipped roles', value: (s.wl_roles || []).length ? s.wl_roles.map((r) => `<@&${r}>`).join(' ') : 'None', inline: true },
    { name: 'Skipped channels', value: (s.wl_channels || []).length ? s.wl_channels.map((c) => `<#${c}>`).join(' ') : 'None', inline: true },
  ).setFooter({ text: `${FOOTER} · Members with Manage Messages are never filtered` });
  return { embeds: [e], components: [
    actionRow(new StringSelectMenuBuilder().setCustomId(sid(viewer, 'automod', 'filters')).setPlaceholder('Choose the filters to turn on').setMinValues(0).setMaxValues(AM_FILTERS.length)
      .addOptions(AM_FILTERS.map(([k, l]) => ({ label: l, value: k, default: on.has(k) })))),
    actionRow(new StringSelectMenuBuilder().setCustomId(sid(viewer, 'automod', 'punish')).setPlaceholder('What happens when a filter triggers')
      .addOptions(AM_PUNISH.map(([k, l]) => ({ label: l, value: k, default: k === (s.punish || 'delete') })))),
    actionRow(new RoleSelectMenuBuilder().setCustomId(sid(viewer, 'automod', 'wlroles')).setPlaceholder('Roles to skip').setMinValues(0).setMaxValues(10)),
    actionRow(new ChannelSelectMenuBuilder().setCustomId(sid(viewer, 'automod', 'wlchannels')).setPlaceholder('Channels to skip').setChannelTypes(...TEXT_CHANNELS).setMinValues(0).setMaxValues(10)),
    actionRow(button(sid(viewer, 'automod', 'limits'), 'Limits', ButtonStyle.Primary), button(sid(viewer, 'automod', 'words'), 'Word list'), backButton(viewer)),
  ] };
}
registerFeature('automod', {
  desc: 'Spam, mention, link, invite, caps and word filters',
  status: (gid) => ((amSet(gid).filters || []).length ? `${amSet(gid).filters.length} filters` : 'Off'),
  render: (guild, viewer) => amPanel(guild, viewer),
  async onComponent(i, action) {
    const g = i.guild, s = amSet(g.id), v = i.user.id;
    if (action === 'filters') putSetting(g.id, 'automod', { ...s, filters: i.values });
    else if (action === 'punish') putSetting(g.id, 'automod', { ...s, punish: i.values[0] });
    else if (action === 'wlroles') putSetting(g.id, 'automod', { ...s, wl_roles: i.values });
    else if (action === 'wlchannels') putSetting(g.id, 'automod', { ...s, wl_channels: i.values });
    else if (action === 'limits') {
      const th = { ...AM_TH, ...(s.th || {}) };
      return i.showModal(makeModal(mid(v, 'automod', 'limits'), 'Automod limits', [
        textInput('spam', 'Spam: messages (2-20)', { required: true, max: 2, value: th.spam }), textInput('spam_secs', 'Spam: within seconds (2-60)', { required: true, max: 2, value: th.spam_secs }),
        textInput('mentions', 'Mentions per message (2-30)', { required: true, max: 2, value: th.mentions }), textInput('repeat', 'Identical messages (2-10)', { required: true, max: 2, value: th.repeat }),
        textInput('caps', 'Capitals percent (40-100)', { required: true, max: 3, value: th.caps })]));
    } else if (action === 'words') {
      return i.showModal(makeModal(mid(v, 'automod', 'words'), 'Filtered words', [textInput('words', 'One word or phrase per line', { long: true, max: 3000, value: (s.words || []).join('\n'), placeholder: 'Nothing is filtered unless you add it here' })]));
    }
    return i.update(amPanel(g, v));
  },
  async onModal(i, action) {
    const g = i.guild, s = amSet(g.id), f = (k) => i.fields.getTextInputValue(k).trim();
    if (action === 'limits') {
      const lim = { spam: [2, 20], spam_secs: [2, 60], mentions: [2, 30], repeat: [2, 10], caps: [40, 100] }, th = {};
      for (const [k, [lo, hi]] of Object.entries(lim)) {
        const n = parseInt(f(k), 10);
        if (!(n >= lo && n <= hi)) throw new UserError(`${k.replace('_', ' ')} must be a number from ${lo} to ${hi}.`);
        th[k] = n;
      }
      putSetting(g.id, 'automod', { ...s, th });
    } else if (action === 'words') {
      const words = [...new Set(f('words').split(/\n|,/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
      if (words.length > 200 || words.some((w) => w.length > 40)) throw new UserError('Use at most 200 words, each up to 40 characters.');
      putSetting(g.id, 'automod', { ...s, words });
    }
    return respond(i, amPanel(g, i.user.id));
  },
});
const amTrack = new Map();
const INVITE_RE = /(discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/i;
const LINK_RE = /https?:\/\/\S+/i;
const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function amCheck(m, s) {
  const f = new Set(s.filters), th = { ...AM_TH, ...(s.th || {}) }, text = m.content || '', now = Date.now();
  const key = `${m.guild.id}:${m.author.id}`;
  const log = (amTrack.get(key) || []).filter((x) => now - x.t < 60e3);
  log.push({ t: now, text: norm(text) });
  amTrack.set(key, log.slice(-25));
  if (amTrack.size > 5000) for (const [k, v] of amTrack) if (!v.length || now - v[v.length - 1].t > 60e3) amTrack.delete(k);
  if (f.has('massmentions') && /@(everyone|here)/.test(text) && !m.member.permissions.has(P.MentionEveryone)) return 'mass mention';
  if (f.has('mentions') && m.mentions && m.mentions.users.size >= th.mentions) return `${m.mentions.users.size} mentions`;
  if (f.has('invites') && INVITE_RE.test(text)) return 'server invite';
  if (f.has('links') && LINK_RE.test(text)) return 'link';
  if (f.has('profanity') && (s.words || []).some((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(w)}($|[^\\p{L}\\p{N}])`, 'iu').test(text))) return 'filtered word';
  if (f.has('caps')) {
    const letters = text.replace(/[^a-zA-Z]/g, '');
    if (letters.length >= 10 && (letters.replace(/[^A-Z]/g, '').length / letters.length) * 100 >= th.caps) return 'excessive capitals';
  }
  if (f.has('repeated') && text && log.filter((x) => x.text === norm(text)).length >= th.repeat) return 'repeated messages';
  if (f.has('spam') && log.filter((x) => now - x.t <= th.spam_secs * 1000).length >= th.spam) return 'spam';
  return null;
}
onMessage(async (m) => {
  const s = amSet(m.guild.id);
  if (!(s.filters || []).length || !m.member) return false;
  if (m.member.permissions.has(P.ManageMessages) || m.member.permissions.has(P.Administrator)) return false;
  if ((s.wl_channels || []).includes(m.channel.id) || (s.wl_roles || []).some((r) => m.member.roles.cache.has(r))) return false;
  const reason = amCheck(m, s);
  if (!reason) return false;
  amTrack.delete(`${m.guild.id}:${m.author.id}`);
  await m.delete().catch(() => {});
  let note = '';
  if (s.punish === 'warn') { const c = createCase(m.guild, 'warn', m.author.id, client.user.id, `Automod: ${reason}`); note = ` A warning was recorded (case #${c.num}).`; }
  if (s.punish === 'mute' && m.member.moderatable) {
    await m.member.timeout(10 * 60e3, `Automod: ${reason}`).catch(() => {});
    createCase(m.guild, 'mute', m.author.id, client.user.id, `Automod: ${reason}`, Date.now() + 10 * 60e3);
    note = ' You were timed out for 10 minutes.';
  }
  const notice = await m.channel.send({ embeds: [failEmbed(`<@${m.author.id}>, your message was removed: ${reason}.${note}`)], allowedMentions: { users: [m.author.id] } }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 6000);
  const lc = getConfig(m.guild.id).mod_log_channel, lch = lc && m.guild.channels.cache.get(lc);
  if (lch) lch.send({ embeds: [embed(getConfig(m.guild.id)).setTitle('Automod').addFields({ name: 'Member', value: `<@${m.author.id}>`, inline: true }, { name: 'Channel', value: `<#${m.channel.id}>`, inline: true },
    { name: 'Reason', value: reason, inline: true }, { name: 'Message', value: clip(m.content || 'No text', 900) })], allowedMentions: { parse: [] } }).catch(() => {});
  return true;
});


/* ------------- 7j. FUN, MAGIC EXTRAS AND MORE MODERATION TOOLS ------------ */
const customCache = new Map();
const toCustomItem = (r) => ({ id: `c${r.id}`, cat: r.cat, name: r.name, rarity: r.rarity, desc: r.description, effect: r.effect, attr: 'Custom entry added by this server' });
const customItems = (gid) => {
  if (!customCache.has(gid)) customCache.set(gid, db.prepare('SELECT * FROM custom_content WHERE guild_id = ?').all(gid).map(toCustomItem));
  return customCache.get(gid);
};
const customItem = (gid, id) => customItems(gid).find((x) => x.id === id) || null;
function pickDiscoveryFor(gid, cat) {
  const cust = customItems(gid).filter((x) => !cat || x.cat === cat);
  if (!cust.length) return pickDiscovery(cat);
  const scope = cat || 'all';
  for (let t = 0; t < 200; t++) {
    const r = rollRarity();
    const pool = [...(POOL[`${scope}|${r}`] || []), ...cust.filter((x) => x.rarity === r)];
    if (pool.length) return randomOf(pool);
  }
  return pickDiscovery(cat);
}
simpleFeature('magic', {
  title: 'Magical discovery', desc: 'Discovery settings and your own custom magical entries',
  blurb: 'Custom entries join the discovery pool in this server only. They appear in /discover, /collection and /codex.',
  fields: [
    { k: 'enabled', label: 'Discovery enabled', type: 'toggle', def: true },
    { k: 'cooldown', label: 'Cooldown between discoveries', type: 'number', min: 0, max: 3600, def: 30, unit: 'seconds' },
    { k: 'daily', label: 'Daily reward enabled', type: 'toggle', def: true },
  ],
  actions: [
    {
      k: 'add', label: 'Add entry', style: ButtonStyle.Primary,
      modal: (g, v) => makeModal(mid(v, 'magic', 'act', 'add'), 'Add a custom entry', [
        textInput('cat', `Category (${Object.keys(CATS).join(', ')})`.slice(0, 45), { required: true, max: 12, placeholder: 'spell, potion, creature...' }),
        textInput('name', 'Name', { required: true, max: 60 }), textInput('desc', 'Description', { long: true, required: true, max: 400 }),
        textInput('effect', 'Effect', { required: true, max: 200 }), textInput('rarity', 'Rarity (Common to Forbidden)', { required: true, max: 10, value: 'Common' })]),
      async submit(i, g, s, fv) {
        const cat = fv('cat').toLowerCase(), rarity = capital(fv('rarity').toLowerCase());
        if (!CATS[cat]) throw new UserError(`Category must be one of: ${Object.keys(CATS).join(', ')}.`);
        if (!RARITIES.includes(rarity)) throw new UserError(`Rarity must be one of: ${RARITIES.join(', ')}.`);
        if (db.prepare('SELECT COUNT(*) n FROM custom_content WHERE guild_id = ?').get(g.id).n >= 500) throw new UserError('A server can have at most 500 custom entries.');
        if (usedNames.has(fv('name').toLowerCase())) throw new UserError('That name is already used by a built-in entry.');
        try { db.prepare('INSERT INTO custom_content (guild_id, cat, name, rarity, description, effect, created_at) VALUES (?,?,?,?,?,?,?)').run(g.id, cat, fv('name'), rarity, fv('desc'), fv('effect'), Date.now()); } catch (e) {
          if (String(e.message).includes('UNIQUE')) throw new UserError('You already have an entry with that name.');
          throw e;
        }
        customCache.delete(g.id);
        return `Added **${fv('name')}** (${rarity} ${CATS[cat]}).`;
      },
    },
    {
      k: 'remove', label: 'Remove entry',
      modal: (g, v) => makeModal(mid(v, 'magic', 'act', 'remove'), 'Remove a custom entry', [textInput('name', 'Name of the entry', { required: true, max: 60 })]),
      async submit(i, g, s, fv) {
        const r = db.prepare('DELETE FROM custom_content WHERE guild_id = ? AND name = ?').run(g.id, fv('name'));
        if (!r.changes) throw new UserError('You have no custom entry with that name.');
        customCache.delete(g.id);
        return `Removed **${fv('name')}**. Members who already found it keep it in their collection.`;
      },
    },
  ],
});

// Daily reward: a free discovery with better odds, and a bigger boost every seventh day
define({
  name: 'daily', description: 'Claim your daily discovery', category: 'Magic',
  async run(ctx) {
    const gid = ctx.guild.id;
    if (getSetting(gid, 'magic', {}).enabled === false || getSetting(gid, 'magic', {}).daily === false) throw new UserError('The daily reward is switched off in this server.');
    const row = db.prepare('SELECT * FROM daily_claims WHERE guild_id = ? AND user_id = ?').get(gid, ctx.user.id);
    const now = new Date(), day = today();
    if (row && row.last_day === day) {
      const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      throw new UserError(`You already claimed today's reward. The next one is ${ts(next)}.`);
    }
    const streak = row && row.last_day === new Date(Date.now() - 864e5).toISOString().slice(0, 10) ? row.streak + 1 : 1;
    const rank = (x) => RARITIES.indexOf(x.rarity);
    let item = pickDiscoveryFor(gid, null);
    const alt = pickDiscoveryFor(gid, null);
    if (rank(alt) > rank(item)) item = alt;
    if (streak % 7 === 0) for (let t = 0; t < 100 && rank(item) < 3; t++) item = pickDiscoveryFor(gid, null);
    db.prepare('INSERT INTO daily_claims (guild_id, user_id, last_day, streak, total) VALUES (?,?,?,?,1) ON CONFLICT (guild_id, user_id) DO UPDATE SET last_day = excluded.last_day, streak = ?, total = total + 1')
      .run(gid, ctx.user.id, day, streak, streak);
    const rec = recordDiscovery(gid, ctx.user.id, item);
    const gain = earn(gid, ctx.member, econ(gid).daily_coins || 0);
    await ctx.reply({ embeds: [itemEmbed(item, `Daily reward · ${streak} day streak${rec.qty > 1 ? ` · duplicate, you hold ${rec.qty}` : ' · new discovery'}${gain ? ` · +${gain} ${coinName(gid)}` : ''}`)], components: [actionRow(button(`dc:${ctx.user.id}`, 'My collection'))] });
  },
});

const EIGHTBALL = ['It is certain.', 'Without a doubt.', 'You may rely on it.', 'The signs say yes.', 'Most likely.', 'Outlook good.', 'Yes, but take care.', 'Ask again when the moon is higher.',
  'The answer is hazy. Try again.', 'Better not to say now.', 'Concentrate and ask again.', 'Do not count on it.', 'My sources say no.', 'The omens are poor.', 'Very doubtful.', 'Not this time.', 'The stars are silent on that one.', 'Only if you act soon.'];
define({
  name: '8ball', description: 'Ask the magic 8-ball', category: 'Fun', options: [opt('string', 'question', 'Your question', true, { rest: true, maxLength: 300 })],
  async run(ctx, a) { await ctx.reply({ embeds: [embed(ctx.cfg, `*${clip(a.question, 250)}*\n\n${randomOf(EIGHTBALL)}`).setTitle('Magic 8-ball')] }); },
});
const SHIP_LINES = [
  ['Not a spark in sight, but opposites have surprised the stars before.', 'The omens are unkind here.', 'Very little in common, plenty of room to grow.'],
  ['A slow start, with potential if given time.', 'Some warmth, some distance.', 'The signs are mixed, which is not nothing.'],
  ['A solid match with a few quirks to learn.', 'Comfortable company and good conversation.', 'The stars lean gently in favour.'],
  ['Strong chemistry and easy laughter.', 'A bright pairing that makes sense.', 'The omens are warm and clear.'],
  ['A rare alignment. The stars approve.', 'Close to perfect. The crystal ball glows.', 'Written in the stars, or at least in pencil.'],
];
define({
  name: 'ship', description: 'See how compatible two members are', category: 'Fun',
  options: [opt('user', 'first', 'First member', true), opt('user', 'second', 'Second member (defaults to you)')],
  async run(ctx, a) {
    const b = a.second || ctx.user, ids = [a.first.id, b.id].sort();
    const pct = hashString(`${ids[0]}:${ids[1]}:${ctx.guild.id}`) % 101;
    await ctx.reply({ embeds: [embed(ctx.cfg, `<@${a.first.id}> and <@${b.id}>\n\n${bar(pct)} **${pct}%**\n${randomOf(SHIP_LINES[Math.min(4, Math.floor(pct / 20))])}`).setTitle('Compatibility')], allowedMentions: { parse: [] } });
  },
});
const COMPLIMENTS = ['Your curiosity makes every conversation more interesting.', 'You have a knack for making others feel welcome.', 'Your sense of humour is a quiet kind of magic.', 'People feel calmer after talking with you.',
  'You notice the small details that others miss.', 'Your ideas improve everything they touch.', 'You carry yourself with a steady, reassuring confidence.', 'You make hard things look manageable.', 'Your kindness leaves a mark.',
  'You are the kind of friend people write stories about.', 'You bring warmth to any room, even a cold one.', 'Your patience would impress a mountain.', 'You have excellent taste, and it shows.', 'You ask the questions that make everyone think.',
  'Your creativity is the real spell here.', 'You are dependable in a way that is rarer than gold.', 'You make this server a better place to be.', 'You listen like it is a skill you have mastered.',
  'Your enthusiasm is contagious in the best way.', 'You have a wonderful way with words.', 'You make complicated plans feel exciting.', 'You are braver than you give yourself credit for.', 'Your laughter improves the atmosphere immediately.', 'You make people feel understood.'];
const ROASTS = ['You have the navigational instincts of a compass in a thunderstorm.', 'Your sense of timing is a clock that only runs on special occasions.', 'You are the reason instructions say to read all the steps first.',
  'You bring a lantern to a daylight party, and somehow it still gets lost.', 'Your plans are so ambitious that even the dragons ask for a rest.', 'You never finish the book, so the bookmark feels unnecessary.',
  'You argue with riddles and somehow lose.', 'You were handed a spell book and used it as a coaster.', 'You would lose a staring contest to a portrait.', 'Your cooking could wake the dead, mostly out of concern.',
  'You treat "five minutes" as a suggestion from a distant land.', 'Your inventory is ninety percent random objects you swear are important.', 'You get lost in the same corridor at the same time every day.',
  'You have never met a snack you could save for later.', 'You tried to tame a cat and ended up as its servant.', 'You collect plans the way others collect dust.', 'You say "one more game" and mean "one more sunrise".',
  'You have a strong opinion about everything and a map of nothing.', 'Your handwriting is a hex no scholar has broken.', 'You are brave until a spider appears.', 'You carry a map and still ask the cat for directions.',
  'You love a good mystery, especially the one about where you left your keys.', 'You once lost an argument to your own echo.', 'You are very punctual, as long as the event started yesterday.'];
define({ name: 'compliment', description: 'Receive a compliment', category: 'Fun', options: [opt('user', 'member', 'Who to compliment (defaults to you)')],
  async run(ctx, a) { await ctx.reply({ embeds: [embed(ctx.cfg, `<@${(a.member || ctx.user).id}>\n\n${randomOf(COMPLIMENTS)}`)], allowedMentions: { parse: [] } }); } });
define({ name: 'roast', description: 'Get a playful roast', category: 'Fun', options: [opt('user', 'member', 'Who to roast (defaults to you)')],
  async run(ctx, a) { await ctx.reply({ embeds: [embed(ctx.cfg, `<@${(a.member || ctx.user).id}>\n\n${randomOf(ROASTS)}`)], allowedMentions: { parse: [] } }); } });
define({ name: 'coinflip', description: 'Flip a coin', category: 'Fun', async run(ctx) { await ctx.reply({ embeds: [embed(ctx.cfg, Math.random() < 0.5 ? '**Heads**' : '**Tails**').setTitle('Coin flip')] }); } });
define({
  name: 'roll', description: 'Roll dice or a random number (for example 20 or 2d6)', category: 'Fun', options: [opt('string', 'dice', 'A maximum like 100, or dice like 2d6 (default 1d100)')],
  async run(ctx, a) {
    const m = (a.dice || '100').toLowerCase().replace(/\s/g, '').match(/^(?:(\d{1,2})?d)?(\d{1,5})$/);
    if (!m) throw new UserError('Use a number like 20, or dice like 2d6.');
    const count = m[1] ? +m[1] : 1, sides = +m[2];
    if (count < 1 || count > 20 || sides < 2) throw new UserError('Roll 1 to 20 dice with at least 2 sides.');
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    await ctx.reply({ embeds: [embed(ctx.cfg, `**${rolls.reduce((x, y) => x + y, 0)}**${count > 1 ? `\n${rolls.join(' + ')}` : ''}`).setTitle(`${count}d${sides}`)] });
  },
});

// Duels
const SPELL_POWER = [[8, 14], [10, 17], [13, 21], [16, 26], [20, 32], [24, 38], [28, 44]];
const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const spellPower = (rarity) => { const [lo, hi] = SPELL_POWER[Math.max(0, RARITIES.indexOf(rarity))]; return rand(lo, hi); };
const duelSpells = (gid, uid) => db.prepare("SELECT item_id, name, rarity FROM collection WHERE guild_id = ? AND user_id = ? AND cat = 'spell'").all(gid, uid)
  .sort((a, b) => RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity) || a.name.localeCompare(b.name));
const spellEffect = (gid, id) => (LIB.get(id) || customItem(gid, id) || { effect: '' }).effect;
const duelRow = (d) => db.prepare('SELECT * FROM duels WHERE id = ?').get(d.id);
function recordDuel(gid, winner, loser) {
  for (const [u, col] of [[winner, 'wins'], [loser, 'losses']]) db.prepare(`INSERT INTO duel_stats (guild_id, user_id, ${col}) VALUES (?,?,1) ON CONFLICT (guild_id, user_id) DO UPDATE SET ${col} = ${col} + 1`).run(gid, u);
}
function quickDuel(a, b) {
  const names = [`<@${a}>`, `<@${b}>`], hp = [100, 100], log = [], spells = BY_CAT.spell.map((x) => x.name);
  let turn = Math.random() < 0.5 ? 0 : 1;
  while (hp[0] > 0 && hp[1] > 0 && log.length < 16) {
    const crit = Math.random() < 0.12, d = Math.round(rand(8, 25) * (crit ? 1.6 : 1));
    hp[1 - turn] -= d;
    log.push(`${names[turn]} casts *${randomOf(spells)}* for ${d}${crit ? ' (critical)' : ''}`);
    turn = 1 - turn;
  }
  return { log, hp, w: hp[0] === hp[1] ? (Math.random() < 0.5 ? 0 : 1) : (hp[0] > hp[1] ? 0 : 1) };
}
function duelPanel(d) {
  const cfg = getConfig(d.guild_id), log = JSON.parse(d.log), cur = d.turn === 1 ? d.p1 : d.p2, active = d.status === 'active';
  const line = (uid, hp) => `<@${uid}>\n${bar(Math.max(0, hp))} ${Math.max(0, hp)}`;
  const e = embed(cfg).setTitle('Duel').setDescription(`${line(d.p1, d.hp1)}\n\n${line(d.p2, d.hp2)}${log.length ? `\n\n${log.slice(-5).join('\n')}` : ''}${active ? `\n\n<@${cur}>, choose your move. You have 90 seconds.` : `\n\n**<@${d.winner}> wins.**`}`);
  if (!active) return { embeds: [e], components: [], allowedMentions: { parse: [] } };
  const used = JSON.parse(cur === d.p1 ? d.used1 : d.used2);
  const spells = duelSpells(d.guild_id, cur).filter((s) => !used.includes(s.item_id)).slice(0, 24);
  const options = [{ label: 'Basic strike', description: 'Always available · 5 to 10 damage', value: 'strike' },
    ...spells.map((s) => ({ label: clip(s.name, 100), description: clip(`${s.rarity} · ${spellEffect(d.guild_id, s.item_id)}`, 100), value: s.item_id }))];
  return { embeds: [e], allowedMentions: { parse: [] }, components: [
    actionRow(new StringSelectMenuBuilder().setCustomId(`dm:mv:${d.id}`).setPlaceholder('Choose a spell you have discovered').addOptions(options)),
    actionRow(button(`dm:ff:${d.id}`, 'Forfeit', ButtonStyle.Danger)),
  ] };
}
function applyMove(d, userId, value) {
  const side = userId === d.p1 ? 1 : 2, foe = side === 1 ? 2 : 1, used = JSON.parse(d[`used${side}`]);
  let dmg, label;
  if (value === 'strike') { dmg = rand(5, 10); label = 'a basic strike'; } else {
    const sp = duelSpells(d.guild_id, userId).find((x) => x.item_id === value);
    if (!sp || used.includes(value)) throw new UserError('You cannot use that spell right now.');
    dmg = spellPower(sp.rarity); label = `*${sp.name}*`; used.push(value);
  }
  const crit = Math.random() < 0.1;
  if (crit) dmg = Math.round(dmg * 1.5);
  const hp = d[`hp${foe}`] - dmg, log = JSON.parse(d.log);
  log.push(`<@${userId}> uses ${label} for ${dmg}${crit ? ' (critical)' : ''}`);
  const patch = { [`used${side}`]: JSON.stringify(used), [`hp${foe}`]: hp, log: JSON.stringify(log.slice(-12)), [`misses${side}`]: 0, turn: foe, deadline: Date.now() + 90e3 };
  if (hp <= 0) { patch.status = 'done'; patch.winner = userId; }
  const cols = Object.keys(patch);
  db.prepare(`UPDATE duels SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => patch[c]), d.id);
  return duelRow(d);
}
async function finishDuel(guild, d) {
  recordDuel(guild.id, d.winner, d.winner === d.p1 ? d.p2 : d.p1);
  const m = await guild.members.fetch(d.winner).catch(() => null);
  if (m) earn(guild.id, m, econ(guild.id).duel_coins || 0);
}
route('dl', async (i, p) => {
  const [, act, a, b] = p, g = i.guild, cfg = getConfig(g.id);
  if (act === 'n') {
    if (![a, b].includes(i.user.id)) throw new UserError('Only the two duellists can answer.');
    return i.update({ embeds: [embed(cfg, 'The duel was called off.')], components: [], allowedMentions: { parse: [] } });
  }
  if (act === 'y') {
    if (i.user.id !== b) throw new UserError('Only the challenged member can answer.');
    return i.update({ embeds: [embed(cfg, `<@${a}> and <@${b}> are ready. Choose how to fight.\n\nQuick fight settles it at once. Choose moves lets each of you pick from the spells you have discovered.`).setTitle('Duel')],
      components: [actionRow(button(`dl:q:${a}:${b}`, 'Quick fight', ButtonStyle.Primary), button(`dl:m:${a}:${b}`, 'Choose moves'))], allowedMentions: { parse: [] } });
  }
  if (![a, b].includes(i.user.id)) throw new UserError('Only the two duellists can choose.');
  if (act === 'q') {
    const r = quickDuel(a, b), winner = [a, b][r.w], loser = [a, b][1 - r.w];
    recordDuel(g.id, winner, loser);
    const wm = await g.members.fetch(winner).catch(() => null);
    if (wm) earn(g.id, wm, econ(g.id).duel_coins || 0);
    const st = db.prepare('SELECT wins, losses FROM duel_stats WHERE guild_id = ? AND user_id = ?').get(g.id, winner);
    return i.update({ embeds: [embed(cfg, `${r.log.slice(0, 10).join('\n')}${r.log.length > 10 ? '\n...' : ''}\n\n<@${winner}> wins with ${Math.max(0, r.hp[r.w])} health left.`).setTitle('Quick fight')
      .setFooter({ text: `${FOOTER} · Winner's record: ${st.wins}-${st.losses}` })], components: [], allowedMentions: { parse: [] } });
  }
  if (act === 'm') {
    for (const u of [a, b]) {
      if (duelSpells(g.id, u).length < 3) throw new UserError(`<@${u}> needs at least 3 discovered spells to duel with their own magic. Use Quick fight instead.`);
    }
    const r = db.prepare('INSERT INTO duels (guild_id, channel_id, message_id, p1, p2, turn, deadline, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(g.id, i.channelId, (i.message && i.message.id) || null, a, b, Math.random() < 0.5 ? 1 : 2, Date.now() + 90e3, Date.now());
    return i.update(duelPanel(db.prepare('SELECT * FROM duels WHERE id = ?').get(Number(r.lastInsertRowid))));
  }
  return undefined;
});
route('dm', async (i, p) => {
  const g = i.guild;
  let d = db.prepare('SELECT * FROM duels WHERE id = ? AND guild_id = ?').get(Number(p[2]), g.id);
  if (!d || d.status !== 'active') throw new UserError('This duel is over.');
  if (![d.p1, d.p2].includes(i.user.id)) throw new UserError('You are not in this duel.');
  if (p[1] === 'ff') {
    const log = JSON.parse(d.log); log.push(`<@${i.user.id}> forfeits`);
    db.prepare("UPDATE duels SET status = 'done', winner = ?, log = ? WHERE id = ?").run(i.user.id === d.p1 ? d.p2 : d.p1, JSON.stringify(log), d.id);
    d = duelRow(d); await finishDuel(g, d);
    return i.update(duelPanel(d));
  }
  if (i.user.id !== (d.turn === 1 ? d.p1 : d.p2)) throw new UserError('It is not your turn.');
  d = applyMove(d, i.user.id, i.values[0]);
  if (d.status === 'done') await finishDuel(g, d);
  return i.update(duelPanel(d));
});
onTick(async () => {
  for (let d of db.prepare("SELECT * FROM duels WHERE status = 'active' AND deadline <= ?").all(Date.now())) {
    const g = client.guilds.cache.get(d.guild_id);
    if (!g) continue;
    const cur = d.turn === 1 ? d.p1 : d.p2, turn = d.turn, missed = d[`misses${turn}`];
    if (missed >= 1) {
      const log = JSON.parse(d.log); log.push(`<@${cur}> ran out of time`);
      db.prepare("UPDATE duels SET status = 'done', winner = ?, log = ? WHERE id = ?").run(cur === d.p1 ? d.p2 : d.p1, JSON.stringify(log), d.id);
      d = duelRow(d);
    } else {
      d = applyMove(d, cur, 'strike');
      db.prepare(`UPDATE duels SET misses${turn} = ? WHERE id = ?`).run(missed + 1, d.id);
      d = duelRow(d);
    }
    if (d.status === 'done') await finishDuel(g, d);
    const ch = g.channels.cache.get(d.channel_id), msg = ch && d.message_id ? await ch.messages.fetch(d.message_id).catch(() => null) : null;
    if (msg) await msg.edit(duelPanel(d)).catch(() => {});
  }
});
define({
  name: 'duel', description: 'Challenge a member to a friendly duel', category: 'Fun', options: [opt('user', 'member', 'Who to challenge', true)],
  async run(ctx, a) {
    if (a.member.bot || a.member.id === ctx.user.id) throw new UserError('Choose another member to duel.');
    await ctx.reply({ content: `<@${a.member.id}>`, embeds: [embed(ctx.cfg, `<@${ctx.user.id}> challenges <@${a.member.id}> to a duel.`).setTitle('Duel challenge')],
      components: [actionRow(button(`dl:y:${ctx.user.id}:${a.member.id}`, 'Accept', ButtonStyle.Success), button(`dl:n:${ctx.user.id}:${a.member.id}`, 'Decline'))], allowedMentions: { users: [a.member.id] } });
  },
});

// Sorting
const HOUSES = [
  { name: 'House Vespera', motto: 'Patience is a lantern.', traits: 'Observant, steady, loyal to the quiet hours.', color: 0x3b6ea5 },
  { name: 'House Aurelith', motto: 'Courage keeps its own time.', traits: 'Bold, generous, quick to answer a challenge.', color: 0xc9a227 },
  { name: 'House Umbrane', motto: 'The unseen holds the truth.', traits: 'Clever, private, drawn to riddles and shadows.', color: 0x7a4fb0 },
  { name: 'House Sylvarin', motto: 'Roots remember.', traits: 'Grounded, inventive, at home in wild places.', color: 0x4a7c59 },
];
define({
  name: 'sorting', description: 'Be sorted into a magical house', category: 'Magic', options: [opt('user', 'member', 'Member to sort (defaults to you)')],
  async run(ctx, a) {
    const u = a.member || ctx.user;
    if (u.bot) throw new UserError('Bots cannot be sorted.');
    let row = db.prepare('SELECT * FROM house_members WHERE guild_id = ? AND user_id = ?').get(ctx.guild.id, u.id), fresh = false;
    if (!row) { const h = Math.floor(Math.random() * HOUSES.length); db.prepare('INSERT INTO house_members (guild_id, user_id, house, at) VALUES (?,?,?,?)').run(ctx.guild.id, u.id, h, Date.now()); row = { house: h }; fresh = true; }
    const house = HOUSES[row.house];
    const tally = HOUSES.map((h, n) => `${h.name} · ${db.prepare('SELECT COUNT(*) c FROM house_members WHERE guild_id = ? AND house = ?').get(ctx.guild.id, n).c}`).join('\n');
    await ctx.reply({ embeds: [new EmbedBuilder().setColor(house.color).setTitle(house.name).setDescription(`<@${u.id}> ${fresh ? 'has been sorted into' : 'belongs to'} **${house.name}**.\n\n*${house.motto}*\n${house.traits}`).addFields({ name: 'Houses', value: tally }).setFooter({ text: FOOTER })], allowedMentions: { parse: [] } });
  },
});

// Mystery challenges built from the library: name the hidden entry from its effect
const mask = (name) => name.split(' ').map((w) => w[0] + '·'.repeat(Math.max(0, w.length - 1))).join('  ');
define({
  name: 'mystery', description: 'Receive a mystery challenge', category: 'Magic',
  async run(ctx) {
    const item = randomOf([...LIB.values()]);
    const e = embed(ctx.cfg, `Name the ${catLabel(item.cat).toLowerCase().replace(/s$/, '')} from its effect:\n\n*${item.effect.replace(/^Fulfilled when: /, '')}*`).setTitle('Mystery challenge')
      .addFields({ name: 'Rarity', value: item.rarity, inline: true }, { name: 'Name', value: `\`${mask(item.name)}\``, inline: true });
    await ctx.reply({ embeds: [e], components: [actionRow(button(`my:g:${item.id}`, 'Make a guess', ButtonStyle.Primary), button(`my:r:${item.id}`, 'Reveal'))] });
  },
});
route('my', async (i, p) => {
  const item = LIB.get(p[2]);
  if (!item) throw new UserError('That challenge has expired.');
  if (p[1] === 'g') return i.showModal(makeModal(`my:gm:${item.id}`, 'Your guess', [textInput('guess', 'What is it called?', { required: true, max: 80 })]));
  if (p[1] === 'r') return i.reply({ embeds: [itemEmbed(item, 'Revealed')], flags: MessageFlags.Ephemeral });
  if (norm(i.fields.getTextInputValue('guess')) === norm(item.name)) return i.reply({ embeds: [embed(getConfig(i.guild.id), `<@${i.user.id}> solved it: **${item.name}**.`)], allowedMentions: { parse: [] } });
  return i.reply({ embeds: [failEmbed('Not quite. Try again, or press Reveal.')], flags: MessageFlags.Ephemeral });
});

// More moderation tools
const checkRole = (ctx, role) => {
  if (role.managed || role.id === ctx.guild.id) throw new UserError('That role cannot be assigned by hand.');
  if (role.position >= ctx.guild.members.me.roles.highest.position) throw new UserError(`${role.name} is above my highest role.`);
  if (ctx.user.id !== ctx.guild.ownerId && role.position >= ctx.member.roles.highest.position) throw new UserError(`${role.name} is equal to or above your highest role.`);
};
define({
  name: 'role', description: 'Add or remove a role', category: 'Moderation', perm: P.ManageRoles, botPerms: P.ManageRoles,
  subs: {
    add: { description: 'Give a member a role', options: [opt('user', 'member', 'Member', true), opt('role', 'role', 'Role', true)],
      async run(ctx, a) { checkRole(ctx, a.role); const m = await requireMember(ctx, a.member); await m.roles.add(a.role.id, auditReason(ctx, 'Role added')); await ctx.ok(`Gave **${a.role.name}** to <@${m.id}>.`); } },
    remove: { description: 'Take a role from a member', options: [opt('user', 'member', 'Member', true), opt('role', 'role', 'Role', true)],
      async run(ctx, a) { checkRole(ctx, a.role); const m = await requireMember(ctx, a.member); await m.roles.remove(a.role.id, auditReason(ctx, 'Role removed')); await ctx.ok(`Took **${a.role.name}** from <@${m.id}>.`); } },
  },
});
define({
  name: 'roleinfo', description: 'Show information about a role', category: 'Utility', options: [opt('role', 'role', 'Role', true)],
  async run(ctx, a) {
    await ctx.reply({ embeds: [embed(ctx.cfg).setTitle(a.role.name).setColor(a.role.color || 0x2b2540).addFields({ name: 'ID', value: a.role.id, inline: true }, { name: 'Members', value: String(a.role.members.size), inline: true },
      { name: 'Created', value: ts(a.role.createdTimestamp, 'D'), inline: true }, { name: 'Position', value: String(a.role.position), inline: true }, { name: 'Mentionable', value: a.role.mentionable ? 'Yes' : 'No', inline: true })] });
  },
});
define({
  name: 'massrole', description: 'Add or remove a role for many members', category: 'Moderation', perm: P.ManageRoles, botPerms: P.ManageRoles,
  options: [opt('string', 'action', 'add or remove', true, { choices: ['add', 'remove'] }), opt('role', 'role', 'Role', true), opt('string', 'target', 'Who it applies to (default humans)', false, { choices: ['humans', 'bots', 'everyone'] })],
  async run(ctx, a) {
    checkRole(ctx, a.role);
    await ctx.defer();
    const members = await ctx.guild.members.fetch();
    const t = a.target || 'humans';
    const list = [...members.values()].filter((m) => (t === 'everyone' || (t === 'bots' ? m.user.bot : !m.user.bot)) && (a.action === 'add' ? !m.roles.cache.has(a.role.id) : m.roles.cache.has(a.role.id)));
    if (list.length > 2000) throw new UserError('That would change more than 2,000 members at once. Narrow it down first.');
    let done = 0;
    for (const m of list) { if (await (a.action === 'add' ? m.roles.add(a.role.id, auditReason(ctx, 'Mass role')) : m.roles.remove(a.role.id, auditReason(ctx, 'Mass role'))).then(() => true).catch(() => false)) done++; }
    await ctx.ok(`${a.action === 'add' ? 'Added' : 'Removed'} **${a.role.name}** ${a.action === 'add' ? 'to' : 'from'} ${done} of ${list.length} members.`);
  },
});
const voiceOf = async (ctx, user) => {
  const m = await requireMember(ctx, user);
  if (!m.voice || !m.voice.channelId) throw new UserError('That member is not in a voice channel.');
  return m;
};
define({ name: 'voicekick', description: 'Disconnect a member from voice', category: 'Moderation', perm: P.MoveMembers, botPerms: P.MoveMembers, options: [opt('user', 'member', 'Member', true)],
  async run(ctx, a) { const m = await voiceOf(ctx, a.member); checkTarget(ctx, a.member, m); await m.voice.disconnect(auditReason(ctx, 'Voice kick')); await ctx.ok(`<@${m.id}> was disconnected from voice.`); } });
define({ name: 'deafen', description: 'Server-deafen a member in voice', category: 'Moderation', perm: P.DeafenMembers, botPerms: P.DeafenMembers, options: [opt('user', 'member', 'Member', true)],
  async run(ctx, a) { const m = await voiceOf(ctx, a.member); checkTarget(ctx, a.member, m); await m.voice.setDeaf(true, auditReason(ctx, 'Deafened')); await ctx.ok(`<@${m.id}> was deafened.`); } });
define({ name: 'undeafen', description: 'Remove a server deafen', category: 'Moderation', perm: P.DeafenMembers, botPerms: P.DeafenMembers, options: [opt('user', 'member', 'Member', true)],
  async run(ctx, a) { const m = await voiceOf(ctx, a.member); await m.voice.setDeaf(false, auditReason(ctx, 'Undeafened')); await ctx.ok(`<@${m.id}> can hear again.`); } });
define({
  name: 'lockdown', description: 'Lock or unlock every text channel', category: 'Moderation', perm: P.ManageChannels, botPerms: P.ManageChannels,
  options: [opt('string', 'action', 'start or end', true, { choices: ['start', 'end'] })],
  async run(ctx, a) {
    await ctx.defer();
    const everyone = ctx.guild.roles.everyone, state = getSetting(ctx.guild.id, 'lockdown', { channels: [] });
    if (a.action === 'start') {
      const changed = [];
      for (const ch of ctx.guild.channels.cache.values()) {
        if (!TEXT_CHANNELS.includes(ch.type) || !ch.permissionsFor(ctx.guild.members.me).has(P.ManageChannels)) continue;
        const ow = ch.permissionOverwrites.cache.get(everyone.id);
        if (ow && ow.deny.has(P.SendMessages)) continue;
        if (await ch.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason: auditReason(ctx, 'Lockdown') }).then(() => true).catch(() => false)) changed.push(ch.id);
      }
      putSetting(ctx.guild.id, 'lockdown', { channels: [...new Set([...state.channels, ...changed])] });
      return ctx.ok(`Locked ${changed.length} channel${changed.length === 1 ? '' : 's'}. Use lockdown end to restore them.`);
    }
    let n = 0;
    for (const id of state.channels) { const ch = ctx.guild.channels.cache.get(id); if (ch && await ch.permissionOverwrites.edit(everyone, { SendMessages: null }, { reason: auditReason(ctx, 'Lockdown ended') }).then(() => true).catch(() => false)) n++; }
    putSetting(ctx.guild.id, 'lockdown', { channels: [] });
    return ctx.ok(`Unlocked ${n} channel${n === 1 ? '' : 's'}.`);
  },
});


/* ------------------------------- 7k. THE SHOP ----------------------------- */
// Members pay with offerings: spare copies of relics from their collection. Discoveries stay recorded; copies are spent.
const shopSet = (gid) => getSetting(gid, 'shop', {});
const shopItem = (id, gid) => db.prepare('SELECT * FROM shop_items WHERE id = ? AND guild_id = ?').get(id, gid);
const shopWares = (gid, listedOnly) => db.prepare(`SELECT * FROM shop_items WHERE guild_id = ?${listedOnly ? ' AND listed = 1' : ''} ORDER BY id`).all(gid);
const tributeOf = (it) => { try { return JSON.parse(it.tribute); } catch { return []; } };
const describeReq = (r) => `${r.n} ${r.cat ? (CATS[r.cat] || r.cat).toLowerCase() : 'discoveries'}${r.min > 0 ? ` of ${RARITIES[r.min]} rarity or higher` : ''}`;
const tributeText = (list) => (list.length ? list.map(describeReq).join(' · ') : 'No tribute');
const stockText = (it) => (it.stock === null || it.stock === undefined ? 'Unlimited' : (it.stock > 0 ? `${it.stock} left` : 'Sold out'));
const costText = (it, gid) => { const parts = tributeOf(it).map(describeReq); if (it.price) parts.push(`${it.price} ${coinName(gid)}`); return parts.length ? parts.join(' · ') : 'Free'; };
function parseTribute(text) {
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
  if (lines.length > 5) throw new UserError('A ware can have at most 5 tribute lines.');
  const help = `Write each line like "2 spell rare" or "3 any". Categories: ${Object.keys(CATS).join(', ')}. Rarities: ${RARITIES.join(', ')}.`;
  const out = [];
  for (const line of lines) {
    const toks = line.toLowerCase().split(/\s+/);
    const n = parseInt(toks.shift(), 10);
    if (!(n >= 1 && n <= 20) || toks.length > 2) throw new UserError(help);
    const r = { n, cat: null, min: 0 };
    for (const raw of toks) {
      const t = raw.replace(/\+$/, '');
      const single = CATS[t] ? t : (t.endsWith('ies') && CATS[`${t.slice(0, -3)}y`] ? `${t.slice(0, -3)}y` : t.replace(/s$/, ''));
      if (t === 'any' || t === 'discoveries') continue;
      if (CATS[single]) r.cat = single;
      else if (RARITIES.map((x) => x.toLowerCase()).includes(t)) r.min = RARITIES.findIndex((x) => x.toLowerCase() === t);
      else throw new UserError(help);
    }
    out.push(r);
  }
  if (out.reduce((x, r) => x + r.n, 0) > 30) throw new UserError('A tribute can ask for at most 30 relics in total.');
  return out;
}
function planOffering(gid, userId, reqs) {
  const rows = db.prepare('SELECT item_id, cat, name, rarity, qty, spent FROM collection WHERE guild_id = ? AND user_id = ?').all(gid, userId)
    .map((r) => ({ ...r, avail: r.qty - r.spent, rank: RARITIES.indexOf(r.rarity) })).filter((r) => r.avail > 0);
  const strict = [...reqs].sort((a, b) => (b.min + (b.cat ? 0.5 : 0)) - (a.min + (a.cat ? 0.5 : 0)));
  const picks = new Map(), missing = [];
  for (const r of strict) {
    let need = r.n;
    const pool = rows.filter((x) => x.avail > 0 && x.rank >= r.min && (!r.cat || x.cat === r.cat)).sort((a, b) => a.rank - b.rank || b.avail - a.avail || a.name.localeCompare(b.name));
    for (const x of pool) {
      if (!need) break;
      const take = Math.min(need, x.avail);
      x.avail -= take; need -= take;
      const p = picks.get(x.item_id) || { id: x.item_id, name: x.name, rarity: x.rarity, units: 0 };
      p.units += take; picks.set(x.item_id, p);
    }
    if (need) missing.push({ r, short: need });
  }
  return { ok: !missing.length, picks: [...picks.values()], missing };
}
const heldCopies = (gid, uid) => db.prepare('SELECT COALESCE(SUM(qty - spent), 0) n FROM collection WHERE guild_id = ? AND user_id = ?').get(gid, uid).n;

// Public storefront
function shopPayload(guild, userId) {
  const s = shopSet(guild.id), items = shopWares(guild.id, true);
  const e = embed(getConfig(guild.id)).setTitle(s.title || 'The Exchange');
  e.setDescription(s.description || 'Offer relics from your collection in return for what the shop holds.');
  for (const w of items.slice(0, 24)) e.addFields({ name: clip(w.name, 100), value: clip(`${costText(w, guild.id)}${w.rank_only ? ' · High rank' : ''}\n${stockText(w)}`, 300) });
  if (!items.length) e.addFields({ name: 'Nothing listed', value: 'Check back soon.' });
  if (userId) e.setFooter({ text: `${FOOTER} · You hold ${heldCopies(guild.id, userId)} spare relics${econ(guild.id).enabled ? ` and ${getWallet(guild.id, userId).coins} ${coinName(guild.id)}` : ''}` });
  const components = items.length ? [actionRow(new StringSelectMenuBuilder().setCustomId('sh:browse').setPlaceholder('Browse the wares')
    .addOptions(items.slice(0, 25).map((w) => ({ label: clip(w.name, 100), description: clip(costText(w, guild.id), 100), value: String(w.id) }))))] : [];
  return { embeds: [e], components };
}
async function refreshShop(guild) {
  const s = shopSet(guild.id);
  if (!s.channel || !s.message) return;
  const ch = guild.channels.cache.get(s.channel), msg = ch ? await ch.messages.fetch(s.message).catch(() => null) : null;
  if (msg) await msg.edit(shopPayload(guild)).catch(() => {});
}
function wareDetail(guild, user, item, member) {
  const plan = planOffering(guild.id, user.id, tributeOf(item)), price = item.price || 0, wallet = getWallet(guild.id, user.id).coins;
  const lack = plan.ok ? [] : plan.missing.map((m) => describeReq({ ...m.r, n: m.short }));
  if (price > wallet) lack.push(`${price - wallet} more ${coinName(guild.id)}`);
  const locked = !!item.rank_only && !perksOf(guild.id, member);
  const e = embed(getConfig(guild.id)).setTitle(item.name).setDescription(item.description || 'No description.').addFields(
    { name: 'Cost', value: costText(item, guild.id) }, { name: 'Available', value: stockText(item), inline: true },
    { name: 'Limit', value: `${item.per_member} per member`, inline: true }, { name: 'Delivery', value: item.needs_staff ? 'Fulfilled by the staff' : (item.role_id ? 'A role, granted instantly' : 'Instant'), inline: true },
    { name: 'Access', value: item.rank_only ? 'High ranks only' : 'Everyone', inline: true },
    { name: 'You', value: locked ? 'This ware is for high ranks only.' : (lack.length ? `You still need ${lack.join(' and ')}.` : 'You can afford this.') });
  const sold = item.stock !== null && item.stock !== undefined && item.stock <= 0;
  return { embeds: [e], components: [actionRow(button(`sh:buy:${item.id}`, tributeOf(item).length ? 'Make an offering' : 'Buy', ButtonStyle.Primary, sold || locked || lack.length > 0))] };
}
function assertBuyable(g, member, item) {
  if (!item || !item.listed) throw new UserError('That ware is no longer available.');
  if (item.rank_only && !perksOf(g.id, member)) throw new UserError('This ware is for high ranks only.');
  if (item.price && !econ(g.id).enabled) throw new UserError('Coins are not enabled in this server.');
  if (item.stock !== null && item.stock !== undefined && item.stock <= 0) throw new UserError('That ware is sold out.');
  const have = db.prepare("SELECT COUNT(*) n FROM shop_orders WHERE guild_id = ? AND item_id = ? AND user_id = ? AND status IN ('complete','pending','fulfilled')").get(g.id, item.id, member.id).n;
  if (have >= item.per_member) throw new UserError(item.per_member === 1 ? 'You have already claimed this ware.' : `You can claim this ware at most ${item.per_member} times.`);
  if (item.role_id && member.roles.cache.has(item.role_id)) throw new UserError('You already hold the role this ware grants.');
  if (item.needs_staff && !(shopSet(g.id).order_channel && g.channels.cache.get(shopSet(g.id).order_channel))) throw new UserError('This ware needs an orders channel. Please tell the staff.');
}
const planHash = (plan) => hashString(plan.picks.map((p) => `${p.id}x${p.units}`).join(',')).toString(36);
function confirmPayload(g, item, plan) {
  const text = [plan.picks.length ? 'These spare relics will be offered. They stay recorded as discovered, but the copies cannot be offered again.' : null,
    item.price ? `${item.price} ${coinName(g.id)} will be taken from your balance.` : null].filter(Boolean).join('\n') || 'Confirm to claim this ware.';
  const e = embed(getConfig(g.id)).setTitle(`${tributeOf(item).length ? 'Offering' : 'Purchase'} for ${item.name}`).setDescription(text)
    .addFields({ name: 'Cost', value: costText(item, g.id) }, ...(plan.picks.length ? [{ name: 'Your offering', value: clip(plan.picks.map((p) => `${p.name} · ${p.rarity}${p.units > 1 ? ` · x${p.units}` : ''}`).join('\n'), 1000) }] : []));
  return { embeds: [e], components: [actionRow(button(`sh:ok:${item.id}:${planHash(plan)}`, 'Confirm', ButtonStyle.Success), button('sh:x:0', 'Cancel'))] };
}
const orderEmbed = (o, status) => {
  const picks = JSON.parse(o.offered || '[]');
  return embed(getConfig(o.guild_id)).setTitle(`Order #${o.id} · ${o.item_name}`).setColor({ pending: 0x2b2540, fulfilled: 0x4a7c59, refused: 0x8b2f3a, complete: 0x4a7c59 }[status || o.status])
    .addFields({ name: 'Member', value: `<@${o.user_id}>`, inline: true }, { name: 'Status', value: capital(status || o.status), inline: true },
      ...(o.paid ? [{ name: 'Paid', value: `${o.paid} ${coinName(o.guild_id)}`, inline: true }] : []),
      { name: 'Offering', value: picks.length ? clip(picks.map((p) => `${p.name} · ${p.rarity}${p.units > 1 ? ` · x${p.units}` : ''}`).join('\n'), 1000) : 'Nothing was required' });
};
function refundOrder(gid, o, status, by, note) {
  db.transaction(() => {
    for (const p of JSON.parse(o.offered || '[]')) db.prepare('UPDATE collection SET spent = MAX(0, spent - ?) WHERE guild_id = ? AND user_id = ? AND item_id = ?').run(p.units, gid, o.user_id, p.id);
    if (o.paid) db.prepare('UPDATE wallets SET coins = coins + ? WHERE guild_id = ? AND user_id = ?').run(o.paid, gid, o.user_id);
    if (o.item_id) db.prepare('UPDATE shop_items SET stock = stock + 1 WHERE id = ? AND stock IS NOT NULL').run(o.item_id);
    db.prepare('UPDATE shop_orders SET status = ?, handled_by = ?, note = ? WHERE id = ?').run(status, by, note || null, o.id);
  })();
}
async function completePurchase(i, item, plan) {
  const g = i.guild;
  const orderId = db.transaction(() => {
    if (item.stock !== null && item.stock !== undefined && !db.prepare('UPDATE shop_items SET stock = stock - 1 WHERE id = ? AND stock > 0').run(item.id).changes) throw new UserError('That ware just sold out.');
    for (const p of plan.picks) {
      if (!db.prepare('UPDATE collection SET spent = spent + ? WHERE guild_id = ? AND user_id = ? AND item_id = ? AND qty - spent >= ?').run(p.units, g.id, i.user.id, p.id, p.units).changes) throw new UserError('Your collection changed. Please try again.');
    }
    if (item.price && !db.prepare('UPDATE wallets SET coins = coins - ? WHERE guild_id = ? AND user_id = ? AND coins >= ?').run(item.price, g.id, i.user.id, item.price).changes) throw new UserError(`You need ${item.price} ${coinName(g.id)}.`);
    return Number(db.prepare('INSERT INTO shop_orders (guild_id, item_id, item_name, user_id, offered, status, created_at, paid) VALUES (?,?,?,?,?,?,?,?)')
      .run(g.id, item.id, item.name, i.user.id, JSON.stringify(plan.picks), item.needs_staff ? 'pending' : 'complete', Date.now(), item.price || 0).lastInsertRowid);
  })();
  const order = db.prepare('SELECT * FROM shop_orders WHERE id = ?').get(orderId);
  try {
    if (item.role_id) await i.member.roles.add(item.role_id, 'Shop purchase');
    if (item.needs_staff) {
      const s = shopSet(g.id), ch = g.channels.cache.get(s.order_channel);
      const msg = await ch.send({ content: s.staff_role ? `<@&${s.staff_role}>` : undefined, embeds: [orderEmbed(order)],
        components: [actionRow(button(`sh:f:${orderId}`, 'Fulfil', ButtonStyle.Success), button(`sh:r:${orderId}`, 'Refuse', ButtonStyle.Danger))], allowedMentions: { roles: s.staff_role ? [s.staff_role] : [] } });
      db.prepare('UPDATE shop_orders SET channel_id = ?, message_id = ? WHERE id = ?').run(ch.id, msg.id, orderId);
    }
  } catch (err) {
    refundOrder(g.id, order, 'refused', null, 'Could not be delivered');
    throw new UserError(item.needs_staff ? 'I could not send your order to the staff, so nothing was spent.' : 'I could not give you the role, so nothing was spent. Please tell the staff.');
  }
  await refreshShop(g);
  return order;
}
route('sh', async (i, p) => {
  const g = i.guild, cfg = getConfig(g.id), act = p[1];
  if (act === 'x') return i.update({ embeds: [embed(cfg, 'Offering cancelled. Nothing was spent.')], components: [] });
  if (act === 'browse') {
    const item = shopItem(Number(i.values[0]), g.id);
    if (!item || !item.listed) throw new UserError('That ware is no longer available.');
    return i.reply({ ...wareDetail(g, i.user, item, i.member), flags: MessageFlags.Ephemeral });
  }
  if (act === 'buy' || act === 'ok') {
    const item = shopItem(Number(p[2]), g.id);
    assertBuyable(g, i.member, item);
    const plan = planOffering(g.id, i.user.id, tributeOf(item));
    if (!plan.ok) throw new UserError(`You still need ${plan.missing.map((m) => describeReq({ ...m.r, n: m.short })).join(' and ')}.`);
    const wal = getWallet(g.id, i.user.id).coins;
    if ((item.price || 0) > wal) throw new UserError(`You need ${item.price - wal} more ${coinName(g.id)}.`);
    if (act === 'buy' || planHash(plan) !== p[3]) {
      const payload = confirmPayload(g, item, plan);
      return act === 'buy' ? i.reply({ ...payload, flags: MessageFlags.Ephemeral }) : i.update(payload);
    }
    const order = await completePurchase(i, item, plan);
    return i.update({ embeds: [embed(cfg, item.needs_staff ? `Your order #${order.id} for **${item.name}** was sent to the staff. You will be messaged when it is handled.` : `Done. **${item.name}** is yours.`).setTitle('Offering accepted')], components: [] });
  }
  if (act === 'f' || act === 'r' || act === 'rm') {
    const s = shopSet(g.id);
    if (!i.memberPermissions.has(P.ManageGuild) && !(s.staff_role && i.member.roles.cache.has(s.staff_role))) throw new UserError('You cannot handle orders.');
    const order = db.prepare('SELECT * FROM shop_orders WHERE id = ? AND guild_id = ?').get(Number(p[2]), g.id);
    if (!order) throw new UserError('That order no longer exists.');
    if (order.status !== 'pending') throw new UserError(`That order was already ${order.status}.`);
    if (act === 'r') return i.showModal(makeModal(`sh:rm:${order.id}`, 'Refuse order', [textInput('reason', 'Reason (optional, sent to the member)', { long: true, max: 400 })]));
    const buyer = await client.users.fetch(order.user_id).catch(() => null);
    if (act === 'f') {
      db.prepare("UPDATE shop_orders SET status = 'fulfilled', handled_by = ? WHERE id = ?").run(i.user.id, order.id);
      await i.update({ embeds: [orderEmbed(order, 'fulfilled').setFooter({ text: `${FOOTER} · Fulfilled by ${i.user.username}` })], components: [] });
      if (buyer) buyer.send({ embeds: [embed(cfg, `Your order for **${order.item_name}** in ${g.name} has been fulfilled.`)] }).catch(() => {});
      return undefined;
    }
    const reason = i.fields.getTextInputValue('reason').trim();
    refundOrder(g.id, order, 'refused', i.user.id, reason);
    const item = order.item_id ? shopItem(order.item_id, g.id) : null;
    if (item && item.role_id) { const m = await g.members.fetch(order.user_id).catch(() => null); if (m) await m.roles.remove(item.role_id, 'Order refused').catch(() => {}); }
    await respond(i, { embeds: [orderEmbed(order, 'refused').setFooter({ text: `${FOOTER} · Refused by ${i.user.username}` })], components: [] });
    if (buyer) buyer.send({ embeds: [embed(cfg, `Your order for **${order.item_name}** in ${g.name} was refused and your offering was returned.${reason ? `\n\nReason: ${reason}` : ''}`)] }).catch(() => {});
    await refreshShop(g);
  }
  return undefined;
});

// Setup panels
function shopHome(guild, viewer) {
  const s = shopSet(guild.id), items = shopWares(guild.id);
  const e = panelEmbed(guild, 'Setup · Shop').setDescription(items.length
    ? items.map((w) => `**${w.name}** · ${costText(w, guild.id)} · ${w.listed ? stockText(w) : 'hidden'}`).join('\n')
    : 'No wares yet. Create one and choose its tribute; nothing is added for you.')
    .addFields({ name: 'Shop channel', value: s.channel ? `<#${s.channel}>` : 'Not published', inline: true }, { name: 'Orders channel', value: s.order_channel ? `<#${s.order_channel}>` : 'Not set', inline: true },
      { name: 'Fulfilment role', value: s.staff_role ? `<@&${s.staff_role}>` : 'Not set', inline: true });
  const rows = [];
  if (items.length) rows.push(actionRow(new StringSelectMenuBuilder().setCustomId(sid(viewer, 'shop', 'open')).setPlaceholder('Open a ware').addOptions(items.slice(0, 25).map((w) => ({ label: clip(w.name, 100), value: String(w.id) })))));
  rows.push(actionRow(channelSelect(sid(viewer, 'shop', 'pub'), 'Publish the shop in a channel')));
  rows.push(actionRow(channelSelect(sid(viewer, 'shop', 'orders'), 'Where staff-fulfilled orders arrive')));
  rows.push(actionRow(new RoleSelectMenuBuilder().setCustomId(sid(viewer, 'shop', 'staffrole')).setPlaceholder('Role pinged for new orders (optional)').setMinValues(0).setMaxValues(1)));
  rows.push(actionRow(button(sid(viewer, 'shop', 'new'), 'New ware', ButtonStyle.Primary, items.length >= 25), button(sid(viewer, 'shop', 'title'), 'Shop title'), backButton(viewer)));
  return { embeds: [e], components: rows };
}
function warePanel(guild, viewer, id) {
  const w = shopItem(id, guild.id);
  if (!w) throw new UserError('That ware no longer exists.');
  const e = panelEmbed(guild, `Ware · ${w.name}`).setDescription(w.description || 'No description set.').addFields(
    { name: 'Cost', value: costText(w, guild.id) }, { name: 'Stock', value: stockText(w), inline: true }, { name: 'Limit', value: `${w.per_member} per member`, inline: true },
    { name: 'Delivery', value: w.needs_staff ? 'Staff fulfil the order' : 'Instant', inline: true }, { name: 'Reward role', value: w.role_id ? `<@&${w.role_id}>` : 'None', inline: true }, { name: 'Status', value: `${w.listed ? 'Listed' : 'Hidden'}${w.rank_only ? ' · High rank only' : ''}`, inline: true });
  return { embeds: [e], components: [
    actionRow(button(sid(viewer, 'shop', 'detail', id), 'Details', ButtonStyle.Primary), button(sid(viewer, 'shop', 'tribute', id), 'Cost'),
      button(sid(viewer, 'shop', 'list', id), w.listed ? 'Hide' : 'List'), button(sid(viewer, 'shop', 'del', id), 'Delete', ButtonStyle.Danger)),
    actionRow(new RoleSelectMenuBuilder().setCustomId(sid(viewer, 'shop', 'role', id)).setPlaceholder('Role granted on purchase (optional)').setMinValues(0).setMaxValues(1)),
    actionRow(button(sid(viewer, 'shop', 'home'), 'Back')),
  ] };
}
registerFeature('shop', {
  desc: 'A shop where members make offerings of relics from their collection',
  status: (gid) => { const n = shopWares(gid).length; return n ? `${n} ware${n === 1 ? '' : 's'}` : 'None'; },
  render: (guild, viewer, arg) => (arg ? warePanel(guild, viewer, Number(arg)) : shopHome(guild, viewer)),
  async onComponent(i, action, args) {
    const g = i.guild, v = i.user.id, s = shopSet(g.id);
    const show = async (arg) => { await refreshShop(g); return i.update(arg ? warePanel(g, v, Number(arg)) : shopHome(g, v)); };
    if (action === 'home') return show();
    if (action === 'new') return i.showModal(makeModal(mid(v, 'shop', 'new'), 'New ware', [textInput('name', 'Name', { required: true, max: 50 }), textInput('description', 'Description (optional)', { long: true, max: 300 })]));
    if (action === 'title') return i.showModal(makeModal(mid(v, 'shop', 'title'), 'Shop title', [textInput('title', 'Title', { max: 80, value: s.title, placeholder: 'The Exchange' }), textInput('description', 'Description', { long: true, max: 300, value: s.description })]));
    if (action === 'orders') { const ch = g.channels.cache.get(i.values[0]); assertCanPost(g, ch); putSetting(g.id, 'shop', { ...s, order_channel: ch.id }); return show(); }
    if (action === 'staffrole') { putSetting(g.id, 'shop', { ...s, staff_role: i.values[0] || null }); return show(); }
    if (action === 'pub') {
      const ch = g.channels.cache.get(i.values[0]);
      if (!shopWares(g.id, true).length) throw new UserError('List at least one ware before publishing.');
      assertCanPost(g, ch);
      const msg = await ch.send(shopPayload(g));
      if (s.channel && s.message) { const old = g.channels.cache.get(s.channel); if (old) old.messages.delete(s.message).catch(() => {}); }
      putSetting(g.id, 'shop', { ...s, channel: ch.id, message: msg.id });
      return show();
    }
    const id = Number(action === 'open' && i.isStringSelectMenu() ? i.values[0] : args[0]);
    if (action === 'open') return show(id);
    const w = shopItem(id, g.id);
    if (!w) throw new UserError('That ware no longer exists.');
    switch (action) {
      case 'detail': return i.showModal(makeModal(mid(v, 'shop', 'detail', id), 'Ware details', [
        textInput('name', 'Name', { required: true, max: 50, value: w.name }), textInput('description', 'Description', { long: true, max: 300, value: w.description }),
        textInput('stock', 'Stock (empty for unlimited)', { max: 6, value: w.stock === null ? '' : w.stock }), textInput('limit', 'Per member limit (1-10)', { required: true, max: 2, value: w.per_member }),
        textInput('staff', 'Staff fulfil the order: yes or no', { required: true, max: 3, value: w.needs_staff ? 'yes' : 'no' })]));
      case 'tribute': return i.showModal(makeModal(mid(v, 'shop', 'tribute', id), 'Cost and access', [
        textInput('lines', 'Relics required, one per line', { long: true, max: 300, value: tributeOf(w).map((r) => `${r.n} ${r.cat || 'any'}${r.min ? ` ${RARITIES[r.min].toLowerCase()}` : ''}`).join('\n'), placeholder: '2 spell rare\n1 potion epic\n3 any' }),
        textInput('price', 'Coin price (empty for none)', { max: 8, value: w.price || '' }), textInput('rank', 'High rank only: yes or no', { max: 3, value: w.rank_only ? 'yes' : 'no' })]));
      case 'list': db.prepare('UPDATE shop_items SET listed = 1 - listed WHERE id = ?').run(id); return show(id);
      case 'role': db.prepare('UPDATE shop_items SET role_id = ? WHERE id = ?').run(i.values[0] || null, id); return show(id);
      case 'del': return i.update({ embeds: [panelEmbed(g, `Delete ${w.name}?`).setDescription('The ware is removed from the shop. Orders already placed keep their records.')],
        components: [actionRow(button(sid(v, 'shop', 'delc', id), 'Delete', ButtonStyle.Danger), button(sid(v, 'shop', 'open', id), 'Cancel'))] });
      case 'delc': db.prepare('DELETE FROM shop_items WHERE id = ?').run(id); return show();
      default: return undefined;
    }
  },
  async onModal(i, action, args) {
    const g = i.guild, v = i.user.id, f = (k) => i.fields.getTextInputValue(k).trim(), s = shopSet(g.id);
    try {
      if (action === 'title') { putSetting(g.id, 'shop', { ...s, title: f('title'), description: f('description') }); await refreshShop(g); return respond(i, shopHome(g, v)); }
      if (action === 'new') {
        const r = db.prepare('INSERT INTO shop_items (guild_id, name, description, created_at) VALUES (?,?,?,?)').run(g.id, f('name'), f('description'), Date.now());
        return respond(i, warePanel(g, v, Number(r.lastInsertRowid)));
      }
      const id = Number(args[0]);
      if (!shopItem(id, g.id)) throw new UserError('That ware no longer exists.');
      if (action === 'detail') {
        const stock = f('stock') === '' ? null : parseInt(f('stock'), 10), limit = parseInt(f('limit'), 10), staff = f('staff').toLowerCase();
        if (stock !== null && !(stock >= 0)) throw new UserError('Stock must be a number, or empty for unlimited.');
        if (!(limit >= 1 && limit <= 10)) throw new UserError('The per member limit must be from 1 to 10.');
        if (!['yes', 'no'].includes(staff)) throw new UserError('Answer yes or no for staff fulfilment.');
        db.prepare('UPDATE shop_items SET name = ?, description = ?, stock = ?, per_member = ?, needs_staff = ? WHERE id = ?').run(f('name'), f('description'), stock, limit, staff === 'yes' ? 1 : 0, id);
      } else if (action === 'tribute') {
        const price = f('price') === '' ? null : parseInt(f('price'), 10), rank = f('rank').toLowerCase() || 'no';
        if (price !== null && !(price >= 1 && price <= 10000000)) throw new UserError('The price must be a whole number of coins, or empty for none.');
        if (!['yes', 'no'].includes(rank)) throw new UserError('Answer yes or no for high rank only.');
        db.prepare('UPDATE shop_items SET tribute = ?, price = ?, rank_only = ? WHERE id = ?').run(JSON.stringify(parseTribute(f('lines'))), price, rank === 'yes' ? 1 : 0, id);
      }
      await refreshShop(g);
      return respond(i, warePanel(g, v, id));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new UserError('A ware with that name already exists.');
      throw e;
    }
  },
});
define({
  name: 'shop', description: 'Open the shop', category: 'Shop',
  async run(ctx) {
    if (!shopWares(ctx.guild.id, true).length) throw new UserError('The shop has nothing listed yet.');
    await ctx.reply(shopPayload(ctx.guild, ctx.user.id), { ephemeral: true });
  },
});
define({
  name: 'orders', description: 'View your shop orders', category: 'Shop', options: [opt('user', 'member', 'Member (staff only)')],
  async run(ctx, a) {
    const u = a.member || ctx.user;
    if (u.id !== ctx.user.id && !ctx.member.permissions.has(P.ManageGuild)) throw new UserError('You can only view your own orders.');
    const rows = db.prepare('SELECT * FROM shop_orders WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 10').all(ctx.guild.id, u.id);
    await ctx.reply({ embeds: [embed(ctx.cfg, rows.length ? rows.map((o) => `**#${o.id}** ${o.item_name} · ${capital(o.status)} · ${ts(o.created_at)}`).join('\n') : 'No orders yet.').setTitle(`Orders · ${u.username}`)] }, { ephemeral: true });
  },
});


/* ---------- 7l. COINS, HIGH RANKS, AFK, THE VAULT AND STAFF ACTIVITY ------ */
const econ = (gid) => getSetting(gid, 'economy', {});
const coinName = (gid) => econ(gid).name || 'coins';
simpleFeature('economy', {
  title: 'Coins', desc: 'Coins members earn and spend in the shop',
  blurb: 'Nothing is earned until you set an amount. Price wares in coins from /setup shop.',
  fields: [
    { k: 'enabled', label: 'Coins enabled', type: 'toggle', def: false },
    { k: 'name', label: 'Currency name', type: 'text', max: 20, def: 'coins', hint: 'For example coins or stardust' },
    { k: 'per_message', label: 'Earned per message', type: 'number', min: 0, max: 100, def: 0 },
    { k: 'message_cooldown', label: 'Message earning cooldown', type: 'number', min: 5, max: 3600, def: 60, unit: 'seconds' },
    { k: 'daily_coins', label: 'Earned from /daily', type: 'number', min: 0, max: 10000, def: 0 },
    { k: 'discovery_coins', label: 'Earned per new discovery', type: 'number', min: 0, max: 1000, def: 0 },
    { k: 'duel_coins', label: 'Earned per duel win', type: 'number', min: 0, max: 10000, def: 0 },
    { k: 'trivia_coins', label: 'Earned per trivia answer', type: 'number', min: 0, max: 1000, def: 0 },
  ],
});
simpleFeature('highrank', {
  title: 'High ranks', desc: 'Exclusive perks for the roles you choose',
  blurb: 'High ranks get discovery luck, a coin boost, a shorter cooldown, the daily /vault and access to rank-only wares in the shop.',
  fields: [
    { k: 'roles', label: 'High rank roles', type: 'roles', max: 5 },
    { k: 'luck', label: 'Discovery luck', type: 'number', min: 0, max: 100, def: 0, unit: '%', hint: 'Chance to keep the better of two rolls' },
    { k: 'coin_boost', label: 'Coin earning boost', type: 'number', min: 100, max: 500, def: 100, unit: '% of normal' },
    { k: 'cooldown', label: 'Discovery cooldown', type: 'number', min: 0, max: 3600, unit: 'seconds' },
    { k: 'vault', label: 'Vault access', type: 'toggle', def: true },
    { k: 'min_rarity', label: 'Lowest rarity high ranks discover', type: 'number', min: 0, max: 6, def: 0, hint: '0 Common, 1 Uncommon, 2 Rare, 3 Epic, 4 Legendary, 5 Mythical, 6 Forbidden' },
    { k: 'mythic_roles', label: 'Roles that can claim mythics', type: 'roles', max: 5, hint: 'Administrators can always use /mythic' },
  ],
});
function perksOf(gid, member) {
  const h = getSetting(gid, 'highrank', {});
  if (!member || !member.roles || !(h.roles || []).some((r) => member.roles.cache.has(r))) return null;
  return { luck: h.luck ?? 0, coin: h.coin_boost ?? 100, cooldown: h.cooldown, vault: h.vault !== false, min: h.min_rarity ?? 0 };
}
function pickAtLeast(gid, cat, minRank) {
  const scope = cat || 'all', cust = customItems(gid).filter((x) => !cat || x.cat === cat), tiers = [];
  for (let k = minRank; k < RARITIES.length; k++) {
    const pool = [...(POOL[`${scope}|${RARITIES[k]}`] || []), ...cust.filter((x) => x.rarity === RARITIES[k])];
    if (pool.length) tiers.push({ pool, w: DROP_RATES[k] });
  }
  if (!tiers.length) return null;
  let r = Math.random() * tiers.reduce((s, x) => s + x.w, 0);
  for (const x of tiers) { r -= x.w; if (r < 0) return randomOf(x.pool); }
  return randomOf(tiers[tiers.length - 1].pool);
}
function pickLucky(gid, cat, luck, minRank = 0) {
  if (minRank > 0) { const f = pickAtLeast(gid, cat, minRank); if (f) return f; }
  let item = pickDiscoveryFor(gid, cat);
  if (luck > 0 && Math.random() * 100 < luck) { const b = pickDiscoveryFor(gid, cat); if (RARITIES.indexOf(b.rarity) > RARITIES.indexOf(item.rarity)) item = b; }
  return item;
}
const getWallet = (gid, uid) => db.prepare('SELECT * FROM wallets WHERE guild_id = ? AND user_id = ?').get(gid, uid) || { coins: 0, earned: 0, last_msg: 0 };
const addCoins = (gid, uid, n) => db.prepare('INSERT INTO wallets (guild_id, user_id, coins, earned) VALUES (?,?,?,?) ON CONFLICT (guild_id, user_id) DO UPDATE SET coins = coins + ?, earned = earned + ?').run(gid, uid, n, n, n, n);
function earn(gid, member, base) {
  if (!econ(gid).enabled || !(base > 0) || !member) return 0;
  const pk = perksOf(gid, member), n = Math.round((base * (pk ? pk.coin : 100)) / 100);
  addCoins(gid, member.id, n);
  return n;
}
onMessage(async (m) => {
  const e = econ(m.guild.id);
  if (!e.enabled || !(e.per_message > 0) || !m.member || (m.content || '').length < 3) return false;
  if ((m.content || '').startsWith(getConfig(m.guild.id).prefix)) return false;
  if (Date.now() - getWallet(m.guild.id, m.author.id).last_msg < (e.message_cooldown ?? 60) * 1000) return false;
  earn(m.guild.id, m.member, e.per_message);
  db.prepare('UPDATE wallets SET last_msg = ? WHERE guild_id = ? AND user_id = ?').run(Date.now(), m.guild.id, m.author.id);
  return false;
});
const PREFIX_SHORTCUTS = { balance: ['coins', 'balance'], bal: ['coins', 'balance'] };
define({
  name: 'coins', description: 'See and manage coins', category: 'Shop',
  subs: {
    balance: {
      description: 'See your coins (or another member\'s)', options: [opt('user', 'member', 'Member (defaults to you)')],
      async run(ctx, a) {
        const u = a.member || ctx.user, w = getWallet(ctx.guild.id, u.id);
        await ctx.reply({ embeds: [embed(ctx.cfg).setTitle(`${capital(coinName(ctx.guild.id))} · ${u.username}`).addFields({ name: 'Balance', value: String(w.coins), inline: true }, { name: 'Earned in total', value: String(w.earned), inline: true },
          { name: 'Spare relics', value: String(heldCopies(ctx.guild.id, u.id)), inline: true })] }, { ephemeral: u.id === ctx.user.id });
      },
    },
    top: {
      description: 'Show the richest members',
      async run(ctx) {
        const rows = db.prepare('SELECT * FROM wallets WHERE guild_id = ? AND coins > 0 ORDER BY coins DESC LIMIT 10').all(ctx.guild.id);
        await ctx.reply({ embeds: [embed(ctx.cfg, rows.length ? rows.map((r, n) => `${n + 1}. <@${r.user_id}> · ${r.coins}`).join('\n') : 'Nobody holds any yet.').setTitle(`Top ${coinName(ctx.guild.id)}`)], allowedMentions: { parse: [] } });
      },
    },
    give: {
      description: 'Give coins to a member', perm: P.ManageGuild, options: [opt('user', 'member', 'Member', true), opt('int', 'amount', 'Amount', true, { min: 1, max: 10000000 })],
      async run(ctx, a) { addCoins(ctx.guild.id, a.member.id, a.amount); await ctx.ok(`Gave ${a.amount} ${coinName(ctx.guild.id)} to <@${a.member.id}>.`); },
    },
    take: {
      description: 'Take coins from a member', perm: P.ManageGuild, options: [opt('user', 'member', 'Member', true), opt('int', 'amount', 'Amount', true, { min: 1, max: 10000000 })],
      async run(ctx, a) {
        db.prepare('INSERT INTO wallets (guild_id, user_id) VALUES (?,?) ON CONFLICT (guild_id, user_id) DO NOTHING').run(ctx.guild.id, a.member.id);
        db.prepare('UPDATE wallets SET coins = MAX(0, coins - ?) WHERE guild_id = ? AND user_id = ?').run(a.amount, ctx.guild.id, a.member.id);
        await ctx.ok(`Took ${a.amount} ${coinName(ctx.guild.id)} from <@${a.member.id}>.`);
      },
    },
    set: {
      description: 'Set a member\'s balance', perm: P.ManageGuild, options: [opt('user', 'member', 'Member', true), opt('int', 'amount', 'New balance', true, { min: 0, max: 100000000 })],
      async run(ctx, a) {
        db.prepare('INSERT INTO wallets (guild_id, user_id, coins) VALUES (?,?,?) ON CONFLICT (guild_id, user_id) DO UPDATE SET coins = excluded.coins').run(ctx.guild.id, a.member.id, a.amount);
        await ctx.ok(`<@${a.member.id}> now has ${a.amount} ${coinName(ctx.guild.id)}.`);
      },
    },
  },
});

// The vault: an exclusive daily discovery for high ranks
function pickVault(gid, luck) {
  const w = DROP_RATES.slice(2), total = w.reduce((x, y) => x + y, 0);
  const one = () => {
    let r = Math.random() * total, rarity = RARITIES[2];
    for (let k = 0; k < w.length; k++) { r -= w[k]; if (r < 0) { rarity = RARITIES[k + 2]; break; } }
    return randomOf([...(POOL[`all|${rarity}`] || []), ...customItems(gid).filter((x) => x.rarity === rarity)]);
  };
  let item = one();
  if (luck > 0 && Math.random() * 100 < luck) { const b = one(); if (RARITIES.indexOf(b.rarity) > RARITIES.indexOf(item.rarity)) item = b; }
  return item;
}
define({
  name: 'vault', description: 'The high rank vault', category: 'Magic',
  subs: {
    open: {
      description: 'Open today\'s vault for a Rare or better discovery',
      async run(ctx) {
        const pk = perksOf(ctx.guild.id, ctx.member);
        if (!pk || !pk.vault) throw new UserError('The vault is open to high ranks only.');
        const row = db.prepare('SELECT last_day FROM vault_claims WHERE guild_id = ? AND user_id = ?').get(ctx.guild.id, ctx.user.id);
        if (row && row.last_day === today()) throw new UserError('You already opened the vault today. It reopens at midnight UTC.');
        const item = pickVault(ctx.guild.id, pk.luck), rec = recordDiscovery(ctx.guild.id, ctx.user.id, item);
        db.prepare('INSERT INTO vault_claims (guild_id, user_id, last_day) VALUES (?,?,?) ON CONFLICT (guild_id, user_id) DO UPDATE SET last_day = excluded.last_day').run(ctx.guild.id, ctx.user.id, today());
        await ctx.reply({ embeds: [itemEmbed(item, `Vault${rec.qty > 1 ? ` · duplicate, you hold ${rec.qty}` : ' · new discovery'}`)] });
      },
    },
    perks: {
      description: 'See the perks of high ranks in this server',
      async run(ctx) {
        const h = getSetting(ctx.guild.id, 'highrank', {}), pk = perksOf(ctx.guild.id, ctx.member);
        if (!(h.roles || []).length) throw new UserError('High ranks have not been set up in this server.');
        await ctx.reply({ embeds: [embed(ctx.cfg, `${pk ? 'You hold a high rank.' : `High ranks: ${h.roles.map((r) => `<@&${r}>`).join(' ')}`}`).setTitle('High rank perks').addFields(
          { name: 'Discovery luck', value: `${h.luck ?? 0}%`, inline: true }, { name: 'Coin boost', value: `${h.coin_boost ?? 100}%`, inline: true },
          { name: 'Cooldown', value: h.cooldown === undefined ? 'Normal' : `${h.cooldown}s`, inline: true }, { name: 'Vault', value: h.vault === false ? 'Off' : 'Daily, Rare or better', inline: true },
          { name: 'Shop', value: 'Rank-only wares', inline: true })], allowedMentions: { parse: [] } });
      },
    },
  },
});

// Mythic access: administrators, plus any roles chosen in /setup highrank, can claim a Mythical discovery whenever they like (no cooldown)
define({
  name: 'mythic', description: 'Claim a Mythical discovery (administrators and chosen roles)', category: 'Magic',
  options: [opt('string', 'category', 'What kind of Mythical to claim (random if omitted)', false, { choices: Object.keys(CATS) })],
  async run(ctx, a) {
    const gid = ctx.guild.id, h = getSetting(gid, 'highrank', {});
    const allowed = ctx.member.permissions.has(P.Administrator) || (h.mythic_roles || []).some((r) => ctx.member.roles.cache.has(r));
    if (!allowed) throw new UserError('Only administrators and the roles chosen in /setup highrank can claim mythics.');
    const cat = a.category || null;
    const pool = [...(POOL[`${cat || 'all'}|Mythical`] || []), ...customItems(gid).filter((x) => x.rarity === 'Mythical' && (!cat || x.cat === cat))];
    if (!pool.length) throw new UserError('There is no Mythical entry in that category yet. Try another category or leave it empty.');
    const item = randomOf(pool), rec = recordDiscovery(gid, ctx.user.id, item);
    await ctx.reply({ embeds: [itemEmbed(item, `Mythic claim${rec.qty > 1 ? ` · duplicate, you hold ${rec.qty}` : ' · new discovery'}`)], components: [actionRow(button(`dc:${ctx.user.id}`, 'My collection'))] });
  },
});

// AFK
const afkCool = new Map();
define({
  name: 'afk', description: 'Let others know you are away', category: 'Utility', options: [opt('string', 'reason', 'Why you are away', false, { rest: true, maxLength: 100 })],
  async run(ctx, a) {
    db.prepare('INSERT INTO afk (guild_id, user_id, reason, since) VALUES (?,?,?,?) ON CONFLICT (guild_id, user_id) DO UPDATE SET reason = excluded.reason, since = excluded.since').run(ctx.guild.id, ctx.user.id, a.reason || '', Date.now());
    await ctx.ok(`You are now AFK${a.reason ? `: ${a.reason}` : ''}. I will tell anyone who mentions you, and clear it when you chat again.`);
  },
});
onMessage(async (m) => {
  const gid = m.guild.id, cfg = getConfig(gid);
  const mine = db.prepare('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?').get(gid, m.author.id);
  if (mine && Date.now() - mine.since > 3000) {
    db.prepare('DELETE FROM afk WHERE guild_id = ? AND user_id = ?').run(gid, m.author.id);
    const n = await m.channel.send({ embeds: [embed(cfg, `Welcome back <@${m.author.id}>. You were AFK for ${fmtDuration(Date.now() - mine.since)}.`)], allowedMentions: { users: [m.author.id] } }).catch(() => null);
    if (n) setTimeout(() => n.delete().catch(() => {}), 8000);
  }
  const lines = [];
  for (const u of m.mentions && m.mentions.users && typeof m.mentions.users.values === 'function' ? [...m.mentions.users.values()] : []) {
    if (u.bot || u.id === m.author.id) continue;
    const row = db.prepare('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?').get(gid, u.id);
    const key = `${m.channel.id}:${u.id}`;
    if (!row || Date.now() - (afkCool.get(key) || 0) < 15000) continue;
    afkCool.set(key, Date.now());
    lines.push(`**${u.username}** is AFK${row.reason ? `: ${row.reason}` : ''}\nAway for ${fmtDuration(Date.now() - row.since)}`);
    if (lines.length >= 3) break;
  }
  if (lines.length) await m.channel.send({ embeds: [embed(cfg, lines.join('\n\n'))], allowedMentions: { parse: [] } }).catch(() => {});
  return false;
});

// Staff activity (rebuilt)
define({
  name: 'staffactivity', description: 'Show staff activity', category: 'Staff', perm: P.ManageRoles,
  options: [opt('user', 'member', 'One staff member (leave empty for the top 10)'), opt('int', 'days', 'How many days to look back (default 7)', false, { min: 1, max: 90 })],
  async run(ctx, a) {
    const gid = ctx.guild.id, days = a.days || 7, from = daysAgo(days - 1), since = Date.now() - days * 864e5;
    const acts = (uid) => db.prepare('SELECT COUNT(*) n FROM cases WHERE guild_id = ? AND mod_id = ? AND created_at > ?').get(gid, uid, since).n;
    if (a.member) {
      const msgs = db.prepare('SELECT COALESCE(SUM(msgs), 0) n FROM staff_activity WHERE guild_id = ? AND user_id = ? AND day >= ?').get(gid, a.member.id, from).n;
      const todayN = db.prepare('SELECT COALESCE(SUM(msgs), 0) n FROM staff_activity WHERE guild_id = ? AND user_id = ? AND day = ?').get(gid, a.member.id, today()).n;
      const last = db.prepare('SELECT MAX(day) d FROM staff_activity WHERE guild_id = ? AND user_id = ? AND msgs > 0').get(gid, a.member.id).d;
      return ctx.reply({ embeds: [embed(ctx.cfg).setTitle(`Activity · ${a.member.username}`).setDescription(`Last ${days} day${days === 1 ? '' : 's'}`).addFields(
        { name: 'Messages', value: String(msgs), inline: true }, { name: 'Today', value: String(todayN), inline: true }, { name: 'Moderation actions', value: String(acts(a.member.id)), inline: true },
        { name: 'Last active', value: last || 'No activity recorded' })] });
    }
    const map = new Map();
    for (const r of db.prepare('SELECT user_id, SUM(msgs) n FROM staff_activity WHERE guild_id = ? AND day >= ? GROUP BY user_id').all(gid, from)) map.set(r.user_id, { msgs: r.n, acts: 0 });
    for (const r of db.prepare('SELECT mod_id AS user_id, COUNT(*) n FROM cases WHERE guild_id = ? AND created_at > ? AND mod_id <> ? GROUP BY mod_id').all(gid, since, client.user.id)) {
      const x = map.get(r.user_id) || { msgs: 0, acts: 0 };
      x.acts = r.n; map.set(r.user_id, x);
    }
    const list = [...map.entries()].sort((x, y) => (y[1].msgs + y[1].acts * 5) - (x[1].msgs + x[1].acts * 5)).slice(0, 10);
    await ctx.reply({ embeds: [embed(ctx.cfg, list.length ? list.map(([u, v], n) => `${n + 1}. <@${u}> · ${v.msgs} messages · ${v.acts} actions`).join('\n')
      : 'No activity recorded yet. Messages are counted for members with your staff hierarchy roles, or for anyone with Manage Messages when no hierarchy is set.').setTitle(`Staff activity · last ${days} day${days === 1 ? '' : 's'}`)], allowedMentions: { parse: [] } });
  },
});
onMessage(async (m) => {
  const s = staffSet(m.guild.id);
  if (s.activity === false || !m.member) return false;
  const tracked = (s.hierarchy || []).length ? s.hierarchy.some((id) => m.member.roles.cache.has(id)) : (m.member.permissions.has(P.ManageMessages) || m.member.permissions.has(P.ModerateMembers));
  if (!tracked) return false;
  db.prepare('INSERT INTO staff_activity (guild_id, user_id, day, msgs) VALUES (?,?,?,1) ON CONFLICT (guild_id, user_id, day) DO UPDATE SET msgs = msgs + 1').run(m.guild.id, m.author.id, today());
  return false;
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
  startTicks();
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
  for (const hook of MESSAGE_HOOKS) {
    try { if (await hook(message)) return; } catch (e) { console.error('Message hook failed:', e); }
  }
  const cfg = getConfig(message.guild.id);
  if (!message.content.startsWith(cfg.prefix)) return;
  const tokens = message.content.slice(cfg.prefix.length).trim().split(/\s+/);
  let first = (tokens.shift() || '').toLowerCase();
  if (PREFIX_SHORTCUTS[first]) { tokens.unshift(PREFIX_SHORTCUTS[first][1]); first = PREFIX_SHORTCUTS[first][0]; }
  const cmd = lookup.get(first);
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
