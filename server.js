const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Auth middleware ───────────────────────────────────────────────────────
const PUBLIC_PATHS = ['/auth/login', '/auth/logout', '/admin/create-manager', '/google/ingest', '/google/products-diagnostic', '/google/dashboard', '/shopify/products'];

async function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.some(function(p){ return req.path.startsWith(p); })) return next();
  if (req.path.match(/\.(css|js|png|jpg|ico|svg|woff|woff2)$/)) return next();

  const token = req.headers['x-auth-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!token) {
    if (req.path === '/' || req.path === '/index.html') return res.redirect('/login.html');
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    if (!db) return next();
    const result = await db.query(
      'SELECT * FROM user_sessions WHERE token=$1 AND expires_at > NOW()',
      [token]
    );
    if (!result.rows.length) {
      if (req.path === '/' || req.path === '/index.html') return res.redirect('/login.html');
      return res.status(401).json({ error: 'Session expired' });
    }
    await db.query(
      "UPDATE user_sessions SET expires_at=NOW() + INTERVAL '24 hours', last_active=NOW() WHERE token=$1",
      [token]
    );
    req.user = result.rows[0];
    next();
  } catch(e) {
    console.error('Auth middleware error: ' + e.message);
    next();
  }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', requireAuth);

let state = {
  accessToken: null,
  tokenExpiry: null,
  profileId: null,
  campaigns: [],
  portfolios: {},
  alerts: [],
  exhaustionLog: [],
  lastSync: null,
  syncing: false,
  error: null
};

// ── Google Ads State ──────────────────────────────────────────────────────
let googleState = {
  campaigns: [],
  alerts: [],
  lastSync: null,
  error: null
};

async function getAccessToken() {
  if (!process.env.AMAZON_REFRESH_TOKEN || !process.env.AMAZON_CLIENT_ID || !process.env.AMAZON_CLIENT_SECRET) {
    throw new Error('Amazon credentials not configured');
  }
  if (state.accessToken && state.tokenExpiry && Date.now() < state.tokenExpiry - 60000) {
    return state.accessToken;
  }
  console.log('Refreshing access token...');
  const res = await axios.post('https://api.amazon.co.uk/auth/o2/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.AMAZON_REFRESH_TOKEN.trim(),
      client_id: process.env.AMAZON_CLIENT_ID.trim(),
      client_secret: process.env.AMAZON_CLIENT_SECRET.trim()
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  state.accessToken = res.data.access_token;
  state.tokenExpiry = Date.now() + (res.data.expires_in * 1000);
  console.log('Token refreshed OK');
  return state.accessToken;
}

async function getProfileId() {
  if (state.profileId) return state.profileId;
  const token = await getAccessToken();
  const res = await axios.get('https://advertising-api-eu.amazon.com/v2/profiles', {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Amazon-Advertising-API-ClientId': process.env.AMAZON_CLIENT_ID.trim()
    }
  });
  const uk = res.data.find(function(p) { return p.countryCode === 'GB' || p.countryCode === 'UK'; }) || res.data[0];
  state.profileId = uk.profileId;
  console.log('Profile ID: ' + state.profileId);
  return state.profileId;
}

function getHeaders(profileId, token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Amazon-Advertising-API-ClientId': process.env.AMAZON_CLIENT_ID.trim(),
    'Amazon-Advertising-API-Scope': String(profileId)
  };
}

async function fetchCampaigns() {
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const headers = Object.assign({}, getHeaders(profileId, token), {
    'Content-Type': 'application/vnd.spCampaign.v3+json',
    'Accept': 'application/vnd.spCampaign.v3+json'
  });
  const res = await axios.post(
    'https://advertising-api-eu.amazon.com/sp/campaigns/list',
    { stateFilter: { include: ['ENABLED'] } },
    { headers: headers }
  );
  const campaigns = res.data.campaigns || res.data || [];
  console.log('Campaigns fetched: ' + campaigns.length);
  return campaigns;
}

let reportState = { pendingReportId: null, data: null, lastFetched: 0, requested: 0 };

async function fetchCampaignStats() {
  const now = Date.now();
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const headers = getHeaders(profileId, token);
  const today = new Date().toISOString().split('T')[0];

  if (reportState.pendingReportId) {
    try {
      const statusRes = await axios.get(
        'https://advertising-api-eu.amazon.com/reporting/reports/' + reportState.pendingReportId,
        { headers: Object.assign({}, headers, { 'Accept': 'application/json' }) }
      );
      const status = statusRes.data.status;
      console.log('Pending report status: ' + status);
      if (status === 'COMPLETED') {
        const downloadRes = await axios.get(statusRes.data.url, { responseType: 'arraybuffer' });
        const zlib = require('zlib');
        const decompressed = zlib.gunzipSync(Buffer.from(downloadRes.data));
        const reportData = JSON.parse(decompressed.toString());
        console.log('Report downloaded: ' + reportData.length + ' records');
        reportState.data = reportData;
        reportState.lastFetched = now;
        reportState.pendingReportId = null;
      } else if (status === 'FAILED') {
        console.log('Report failed, will retry next cycle');
        reportState.pendingReportId = null;
      }
    } catch(e) {
      console.error('Report check error: ' + e.message);
      reportState.pendingReportId = null;
    }
  }

  if (!reportState.pendingReportId && (now - reportState.requested) > 2 * 60 * 60 * 1000) {
    try {
      const reportRes = await axios.post(
        'https://advertising-api-eu.amazon.com/reporting/reports',
        {
          name: 'CampaignPulse ' + today,
          startDate: today,
          endDate: today,
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS',
            groupBy: ['campaign'],
            columns: ['campaignId', 'campaignName', 'cost', 'sales14d', 'clicks', 'impressions', 'purchases14d', 'clickThroughRate'],
            reportTypeId: 'spCampaigns',
            timeUnit: 'SUMMARY',
            format: 'GZIP_JSON'
          }
        },
        { headers: Object.assign({}, headers, { 'Content-Type': 'application/json', 'Accept': 'application/json' }) }
      );
      reportState.pendingReportId = reportRes.data.reportId;
      reportState.requested = now;
      console.log('Report requested: ' + reportState.pendingReportId + ' (will check next sync)');
    } catch(e) {
      console.error('Report request error: ' + e.message);
    }
  }

  return reportState.data || null;
}

async function updateBudget(campaignId, newBudget) {
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const headers = Object.assign({}, getHeaders(profileId, token), {
    'Content-Type': 'application/vnd.spCampaign.v3+json',
    'Accept': 'application/vnd.spCampaign.v3+json'
  });
  try {
    const res = await axios.put(
      'https://advertising-api-eu.amazon.com/sp/campaigns',
      { campaigns: [{ campaignId: String(campaignId), budget: { budget: newBudget, budgetType: 'DAILY' } }] },
      { headers: headers }
    );
    console.log('Budget updated v3: ' + JSON.stringify(res.data).substring(0, 200));
    return res.data;
  } catch(e) {
    console.error('Budget update error: ' + e.response?.status + ' ' + JSON.stringify(e.response?.data));
    throw e;
  }
}

async function sendGoogleChat(message) {
  if (!process.env.GOOGLE_CHAT_WEBHOOK) return;
  await new Promise(function(resolve) { setTimeout(resolve, 1000); });
  try {
    await axios.post(process.env.GOOGLE_CHAT_WEBHOOK, { text: message });
    console.log('Google Chat sent');
  } catch(e) {
    console.error('Google Chat error: ' + e.message);
  }
}

async function analyseCampaigns(campaigns) {
  const acosCritical = parseFloat(process.env.ACOS_CRITICAL_THRESHOLD || 35);
  const budgetLowPct = parseFloat(process.env.BUDGET_LOW_PERCENT || 20);
  const now = new Date();
  state.alerts = state.alerts.filter(function(a) { return a.date === now.toDateString(); });
  const timeStr = now.toLocaleTimeString('en-GB', {timeZone:'Europe/London', hour:'2-digit', minute:'2-digit'});
  const dateStr = now.toDateString();

  for (let i = 0; i < campaigns.length; i++) {
    const c = campaigns[i];
    const budget = c.dailyBudget || 0;
    const spend = c.spend || 0;
    const sales = c.sales || 0;
    const acos = sales > 0 ? (spend / sales) * 100 : 0;
    const remaining = Math.max(0, budget - spend);
    const remainingPct = budget > 0 ? (remaining / budget) * 100 : 100;
    const outOfBudget = remaining <= 0.01 && budget > 0;
    const budgetLow = remainingPct <= budgetLowPct && !outOfBudget;
    const acosHigh = acos > acosCritical && spend > 5;
    const ukHour = parseInt(new Date().toLocaleString('en-GB', {timeZone:'Europe/London', hour:'numeric', hour12:false}));
    if (ukHour >= 22 || ukHour < 8) continue;
    const alertType = outOfBudget ? 'out_of_budget' : acosHigh ? 'acos_high' : budgetLow ? 'budget_low' : null;
    if (!alertType) continue;

    let alreadyAlerted = state.alerts.find(function(a) {
      return a.campaignId === c.campaignId && a.date === dateStr && a.type === alertType;
    });
    if (!alreadyAlerted && db) {
      try {
        const dbAlert = await db.query(
          "SELECT id FROM campaign_tasks WHERE campaign_id=$1 AND task_source='alert' AND problem_type=$2 AND created_date=CURRENT_DATE",
          [String(c.campaignId), alertType]
        );
        if (dbAlert.rows.length > 0) alreadyAlerted = true;
      } catch(e) {}
    }
    if (alreadyAlerted) continue;
    if (db) {
      try {
        const suppressed = await db.query(
          'SELECT id FROM campaign_tasks WHERE campaign_id=$1 AND status=$2 AND DATE(suppressed_until)=CURRENT_DATE',
          [String(c.campaignId), 'dismissed']
        );
        if (suppressed.rows.length > 0) continue;
      } catch(e) {}
    }

    const name = c.name || 'Unknown';
    const agent = extractAgentFromCampaign(name) || '';
    const portfolioName = c.portfolio || '';

    state.alerts.push({ campaignId: c.campaignId, name: name, portfolio: portfolioName, agent: agent, type: alertType, time: timeStr, date: dateStr, budget: budget, acos: Math.round(acos * 10) / 10 });

    const dashUrl = process.env.DASHBOARD_URL || 'https://campaignpulse-setup-production.up.railway.app';

    if (outOfBudget) {
      const hoursLeft = (23 * 60 + 59 - now.getHours() * 60 - now.getMinutes()) / 60;
      const roas = spend > 0 ? sales / spend : 0;
      const hourly = spend / Math.max(now.getHours(), 1);
      const missed = Math.round(hourly * hoursLeft * roas);
      state.exhaustionLog.unshift({ date: now.toLocaleDateString('en-GB'), time: timeStr, campaign: name, portfolio: portfolioName, agent: agent, budget: '£' + budget.toFixed(2), acos: acos.toFixed(1) + '%', missed: '£' + missed, added: 'Pending', action: 'Pending' });
      const m1 = ['⚠ OUT OF BUDGET', name, 'Time: ' + timeStr, 'Budget: £' + budget.toFixed(2), 'ACOS: ' + acos.toFixed(1) + '%', 'Est. missed: ~£' + missed, dashUrl].join('\n');
      if (agent) { await sendToAgent(agent, m1); } else { await sendGoogleChat(m1); }
      createAlertTask(c.campaignId, name, agent, portfolioName, 'out_of_budget', 'Ran out at ' + timeStr + '. Budget £' + budget.toFixed(2) + ', ACOS ' + acos.toFixed(1) + '%');
    } else if (acosHigh) {
      const m2 = ['📈 HIGH ACOS', name, 'ACOS: ' + acos.toFixed(1) + '%', 'Spend: £' + spend.toFixed(2), dashUrl].join('\n');
      if (agent) { await sendToAgent(agent, m2); } else { await sendGoogleChat(m2); }
      createAlertTask(c.campaignId, name, agent, portfolioName, 'high_acos', 'ACOS ' + acos.toFixed(1) + '% with £' + spend.toFixed(2) + ' spend');
    } else if (budgetLow) {
      const m3 = ['⚡ BUDGET LOW', name, 'Remaining: £' + remaining.toFixed(2) + ' (' + remainingPct.toFixed(0) + '%)', dashUrl].join('\n');
      if (agent) { await sendToAgent(agent, m3); } else { await sendGoogleChat(m3); }
      createAlertTask(c.campaignId, name, agent, portfolioName, 'budget_low', 'Budget ' + remainingPct.toFixed(0) + '% used, £' + remaining.toFixed(2) + ' left');
    }
  }
  console.log('Alert analysis complete');
}

async function syncCampaigns() {
  if (state.syncing) return;
  state.syncing = true;
  console.log('Syncing at ' + new Date().toTimeString().slice(0, 8));
  try {
    const raw = await fetchCampaigns();
    const stats = await fetchCampaignStats();
    const statsMap = {};
    if (stats && stats.length) {
      stats.forEach(function(s) {
        statsMap[s.campaignId] = {
          spend: parseFloat(s.cost || 0),
          sales: parseFloat(s.sales14d || 0),
          clicks: parseInt(s.clicks || 0),
          impressions: parseInt(s.impressions || 0),
          conversions: parseInt(s.purchases14d || 0),
          ctr: parseFloat(s.clickThroughRate || 0),
          portfolio: s.portfolioName || '',
          portfolioId: s.portfolioId || ''
        };
      });
      console.log('Stats loaded for ' + Object.keys(statsMap).length + ' campaigns');
    }

    const campaigns = raw.map(function(c) {
      const budget = parseFloat((c.budget && c.budget.budget) || c.dailyBudget || 0);
      const s = statsMap[c.campaignId] || {};
      const spend = s.spend !== undefined ? parseFloat(s.spend) : null;
      const sales = s.sales !== undefined ? parseFloat(s.sales) : null;
      const acos = sales > 0 ? Math.round((spend / sales) * 1000) / 10 : 0;
      const remaining = Math.max(0, budget - spend);
      const pct = budget > 0 ? Math.round((spend / budget) * 100) : 0;
      const portfolioName = c.portfolioId ? (state.portfolios[c.portfolioId] || '') : '';
      const agent = portfolioName ? portfolioName.replace('@', '').split(' ')[0] : '';
      return {
        campaignId: c.campaignId,
        name: c.name || '',
        state: (c.state || '').toLowerCase(),
        targetingType: (c.targetingType || '').toLowerCase(),
        portfolio: portfolioName,
        agent: agent,
        dailyBudget: budget,
        spend: spend !== null ? Math.round(spend * 100) / 100 : null,
        sales: sales !== null ? Math.round(sales * 100) / 100 : null,
        acos: acos,
        clicks: s.clicks || 0,
        impressions: s.impressions || 0,
        conversions: s.conversions || 0,
        ctr: s.ctr ? (s.ctr * 100).toFixed(2) : '0.00',
        budgetRemaining: Math.round(remaining * 100) / 100,
        budgetPct: pct
      };
    });

    state.campaigns = campaigns;
    await analyseCampaigns(campaigns);
    state.lastSync = new Date().toLocaleTimeString('en-GB', {timeZone:'Europe/London', hour:'2-digit', minute:'2-digit', second:'2-digit'});
    state.error = null;
    console.log('Sync done. ' + campaigns.length + ' campaigns.');
    saveDailySnapshot().catch(function(e){ console.error('Snapshot error: ' + e.message); });
  } catch(e) {
    state.error = e.message;
    console.error('Sync error:', e.message);
  } finally {
    state.syncing = false;
  }
}

// ── Database ──────────────────────────────────────────────────────────────
let db = null;

async function initDB() {
  if (!process.env.DATABASE_URL) { console.log('No DATABASE_URL - skipping DB'); return; }
  try {
    const { Client } = require('pg');
    db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await db.query(`
      CREATE TABLE IF NOT EXISTS daily_snapshots (
        id SERIAL PRIMARY KEY,
        snapshot_date DATE NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT NOW(),
        metrics JSONB,
        campaigns JSONB,
        exhaustion_log JSONB,
        alerts JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_snapshot_date ON daily_snapshots(snapshot_date);
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        settings JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT NOW()
      );
      INSERT INTO app_settings (id, settings) VALUES (1, '{}') ON CONFLICT (id) DO NOTHING;
    `);
    console.log('Database connected and tables ready');
    await initTasksTable();
  } catch(e) {
    console.error('DB init error: ' + e.message);
    db = null;
  }
}

async function saveDailySnapshot() {
  if (!db) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    const campaigns = state.campaigns;
    const totalRevenue = campaigns.reduce(function(s,c){ return s+(c.sales||0); }, 0);
    const totalSpend = campaigns.reduce(function(s,c){ return s+(c.spend||0); }, 0);
    const blendedAcos = totalRevenue > 0 ? Math.round((totalSpend/totalRevenue)*1000)/10 : 0;
    const metrics = {
      totalRevenue: totalRevenue.toFixed(2),
      totalSpend: totalSpend.toFixed(2),
      blendedAcos,
      activeCampaigns: campaigns.filter(function(c){ return c.state==='enabled'; }).length,
      totalCampaigns: campaigns.length,
      outOfBudget: campaigns.filter(function(c){ return c.budgetRemaining<=0.01&&c.dailyBudget>0; }).length,
      spendNoRevenue: campaigns.filter(function(c){ return c.spend>0&&(c.sales===0||c.sales===null); }).length,
      totalWastedSpend: campaigns.filter(function(c){ return c.spend>0&&(c.sales===0||c.sales===null); }).reduce(function(s,c){ return s+(c.spend||0); }, 0).toFixed(2)
    };
    await db.query(
      'INSERT INTO daily_snapshots (snapshot_date, metrics, campaigns, exhaustion_log, alerts) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (snapshot_date) DO UPDATE SET metrics=$2, campaigns=$3, exhaustion_log=$4, alerts=$5, created_at=NOW()',
      [today, JSON.stringify(metrics), JSON.stringify(campaigns), JSON.stringify(state.exhaustionLog), JSON.stringify(state.alerts)]
    );
    console.log('Daily snapshot saved for ' + today);
  } catch(e) {
    console.error('Snapshot save error: ' + e.message);
  }
}

async function getDailySnapshot(date) {
  if (!db) return null;
  try {
    const dateStr = String(date).split('T')[0];
    const res = await db.query("SELECT *, TO_CHAR(snapshot_date, 'YYYY-MM-DD') as snapshot_date FROM daily_snapshots WHERE snapshot_date = $1", [dateStr]);
    return res.rows[0] || null;
  } catch(e) {
    console.error('Snapshot fetch error: ' + e.message);
    return null;
  }
}

async function getSnapshotDates() {
  if (!db) return [];
  try {
    const res = await db.query("SELECT TO_CHAR(snapshot_date, 'YYYY-MM-DD') as snapshot_date, metrics FROM daily_snapshots ORDER BY snapshot_date DESC LIMIT 30");
    return res.rows;
  } catch(e) { return []; }
}

// ── Agent webhook routing ─────────────────────────────────────────────────
function getAgentWebhook(agentName) {
  if (!agentName) return null;
  try {
    const mapping = JSON.parse(process.env.AGENT_WEBHOOKS || '{}');
    const varName = mapping[agentName];
    if (varName && process.env[varName]) return process.env[varName];
  } catch(e) {}
  return null;
}

function extractAgentFromCampaign(campaignName) {
  if (!campaignName) return null;
  const parts = campaignName.split(/[|@]/);
  const name = parts[0].trim();
  return name.length > 0 && name.length < 30 ? name : null;
}

async function sendToAgent(agentName, message) {
  const webhook = getAgentWebhook(agentName);
  if (webhook) {
    try {
      await axios.post(webhook, { text: message });
      console.log('Sent to agent space: ' + agentName);
      return true;
    } catch(e) {
      console.error('Agent webhook error (' + agentName + '): ' + e.message);
    }
  }
  return false;
}

// ── Tasks table init ───────────────────────────────────────────────────────
async function initTasksTable() {
  if (!db) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS campaign_tasks (
        id SERIAL PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        campaign_name TEXT NOT NULL,
        agent_name TEXT,
        portfolio TEXT,
        problem_type TEXT NOT NULL,
        problem_detail TEXT,
        days_persisted INTEGER DEFAULT 1,
        total_wasted NUMERIC DEFAULT 0,
        score INTEGER DEFAULT 0,
        status TEXT DEFAULT 'open',
        agent_notes TEXT,
        task_source TEXT DEFAULT 'daily',
        created_date DATE DEFAULT CURRENT_DATE,
        updated_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_agent ON campaign_tasks(agent_name);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON campaign_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_date ON campaign_tasks(created_date);
    `);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS task_source TEXT DEFAULT 'daily'`);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS dismissed_reason TEXT`);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS suppressed_until TIMESTAMP`);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS paused_reason TEXT`);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP`);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS first_action_at TIMESTAMP`);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS days_persisted INTEGER DEFAULT 1`);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS total_wasted NUMERIC DEFAULT 0`);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP`);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS escalation_reason TEXT`);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS scaling_deadline TIMESTAMP`);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS failure_count INTEGER DEFAULT 1`);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS last_resolved_date TIMESTAMP`);
    await db.query(`ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS is_repeat_offender BOOLEAN DEFAULT FALSE`);
    console.log('Tasks table ready');

    await db.query(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id SERIAL PRIMARY KEY,
        campaign_id TEXT,
        campaign_name TEXT,
        agent_name TEXT,
        action TEXT NOT NULL,
        notes TEXT,
        status_before TEXT,
        status_after TEXT,
        task_id INTEGER,
        logged_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_log(agent_name);
      CREATE INDEX IF NOT EXISTS idx_activity_campaign ON activity_log(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_activity_logged ON activity_log(logged_at DESC);
    `);
    console.log('Activity log table ready');

    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        department TEXT NOT NULL DEFAULT 'amazon',
        role TEXT NOT NULL DEFAULT 'agent',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        last_login TIMESTAMP
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        token TEXT UNIQUE NOT NULL,
        department TEXT NOT NULL,
        role TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        last_active TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query('CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at)');

    await db.query("ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS department TEXT DEFAULT 'amazon'");
    await db.query("ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS department TEXT DEFAULT 'amazon'");
    await db.query("ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS notes_ignored BOOLEAN DEFAULT FALSE");

    try {
      const userCount = await db.query('SELECT COUNT(*) as cnt FROM users');
      if (parseInt(userCount.rows[0].cnt) === 0) {
        const hash = await bcrypt.hash('FKSports2024!', 10);
        await db.query(
          'INSERT INTO users (name, email, password_hash, department, role) VALUES ($1,$2,$3,$4,$5)',
          ['Bobby', 'bobby@fksports.co.uk', hash, 'manager', 'manager']
        );
        console.log('Default manager account created: bobby@fksports.co.uk / FKSports2024!');
      }
    } catch(e) { console.error('User init error: ' + e.message); }
    console.log('Auth tables ready');

    // ── FIX: Reload today alerts using created_date (not created_at) ──────
    try {
      const todayAlerts = await db.query(
        "SELECT campaign_id, campaign_name, problem_type, problem_detail, created_date FROM campaign_tasks WHERE task_source='alert' AND created_date=CURRENT_DATE"
      );
      todayAlerts.rows.forEach(function(row) {
        const existing = state.alerts.find(function(a){ return String(a.campaignId) === String(row.campaign_id) && a.type === row.problem_type; });
        if (!existing) {
          state.alerts.push({
            campaignId: row.campaign_id,
            name: row.campaign_name || 'Unknown',
            type: row.problem_type,
            time: new Date().toLocaleTimeString('en-GB', {timeZone:'Europe/London', hour:'2-digit', minute:'2-digit'}),
            date: new Date().toDateString(),
            acos: 0,
            budget: 0
          });
        }
      });
      console.log('Reloaded ' + todayAlerts.rows.length + ' alerts from DB');
    } catch(e) { console.error('Alert reload error: ' + e.message); }

    await db.query(`
      CREATE TABLE IF NOT EXISTS keyword_dismissals (
        id SERIAL PRIMARY KEY,
        search_term TEXT NOT NULL,
        campaign TEXT NOT NULL,
        reason TEXT NOT NULL,
        dismissed_by TEXT,
        dismissed_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_kw_dismiss_term ON keyword_dismissals(search_term, campaign);
    `);

    try {
      const tasks = await db.query('SELECT id, campaign_name FROM campaign_tasks WHERE campaign_name IS NOT NULL');
      let fixed = 0;
      for (const row of tasks.rows) {
        const parts = (row.campaign_name||'').split(/[|@]/);
        const name = parts[0].trim();
        const agentName = (name.length > 0 && name.length < 30) ? name : null;
        if (agentName) {
          await db.query('UPDATE campaign_tasks SET agent_name=$1 WHERE id=$2', [agentName, row.id]);
          fixed++;
        }
      }
      if (fixed > 0) console.log('Fixed ' + fixed + ' task agent names');
    } catch(e) { console.error('Agent name fix error: ' + e.message); }
  } catch(e) {
    console.error('Tasks table error: ' + e.message);
  }
}

function scoreCampaignDays(days) {
  let baseScore = 0;
  let consecutiveDays = days.length;
  const totalSpend = days.reduce(function(s,d){ return s+(d.spend||0); }, 0);
  const totalSales = days.reduce(function(s,d){ return s+(d.sales||0); }, 0);
  const avgAcos = days.filter(function(d){ return d.spend>0; }).reduce(function(s,d,_,a){ return s+d.acos/a.length; }, 0);
  const noActivityDays = days.filter(function(d){ return (d.impressions||0)===0; }).length;
  const spendDays = days.filter(function(d){ return (d.spend||0)>0; });
  const noRevDays = spendDays.filter(function(d){ return (d.sales||0)===0; }).length;

  if (noRevDays >= 1) {
    if (totalSpend > 15) baseScore += 10;
    else if (totalSpend > 10) baseScore += 7;
    else if (totalSpend > 5) baseScore += 5;
  }
  if (avgAcos > 50 && totalSpend > 10) baseScore += 8;
  else if (avgAcos > 35 && totalSpend > 5) baseScore += 5;
  if (noActivityDays >= 3) baseScore += 8;
  else if (noActivityDays >= 2) baseScore += 5;
  else if (noActivityDays >= 1) baseScore += 2;

  const multiplier = Math.min(consecutiveDays, 3);
  const finalScore = baseScore * multiplier;
  return { score: finalScore, noActivityDays, noRevDays, totalSpend: totalSpend.toFixed(2), totalSales: totalSales.toFixed(2), avgAcos: avgAcos.toFixed(1) };
}

async function createAlertTask(campaignId, campaignName, agentName, portfolio, problemType, problemDetail) {
  if (!db) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    const existing = await db.query(
      'SELECT id FROM campaign_tasks WHERE campaign_id=$1 AND created_date=$2 AND problem_type=$3 AND task_source=$4',
      [String(campaignId), today, problemType, 'alert']
    );
    if (existing.rows.length > 0) return;
    const scoreMap = { out_of_budget: 15, budget_low: 8, high_acos: 10 };
    await db.query(
      'INSERT INTO campaign_tasks (campaign_id, campaign_name, agent_name, portfolio, problem_type, problem_detail, score, task_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [String(campaignId), campaignName, agentName||'Unassigned', portfolio||'', problemType, problemDetail, scoreMap[problemType]||8, 'alert']
    );
    console.log('Alert task created: ' + campaignName + ' (' + problemType + ')');
  } catch(e) {
    console.error('Alert task error: ' + e.message);
  }
}

async function runDailyTaskScheduler() {
  if (!db) { console.log('No DB - skipping task scheduler'); return; }
  console.log('Running daily task scheduler...');
  const dashUrl = process.env.DASHBOARD_URL || 'https://campaignpulse-setup-production.up.railway.app';

  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const result = await db.query(
      'SELECT snapshot_date, campaigns FROM daily_snapshots WHERE snapshot_date <= $1 ORDER BY snapshot_date DESC LIMIT 3',
      [yesterdayStr]
    );

    if (!result.rows.length) { console.log('No historical snapshots yet for task scheduler'); return; }
    console.log('Task scheduler using ' + result.rows.length + ' days of history');

    const agentCampaigns = {};
    const campHistory = {};

    result.rows.forEach(function(snap) {
      const camps = snap.campaigns || [];
      camps.forEach(function(c) {
        if (!c.campaignId) return;
        const agent = extractAgentFromCampaign(c.name) || 'Unassigned';
        if (!['Aryan','Satyam','Kunal'].includes(agent)) return;
        if (!campHistory[c.campaignId]) {
          campHistory[c.campaignId] = { campaignId: c.campaignId, name: c.name || '', agent: agent, portfolio: c.portfolio || '', targetingType: c.targetingType || '', days: [] };
        }
        campHistory[c.campaignId].days.push({ date: snap.snapshot_date, impressions: c.impressions || 0, spend: c.spend || 0, sales: c.sales || 0, acos: c.acos || 0, dailyBudget: c.dailyBudget || 0 });
        if (!agentCampaigns[agent]) agentCampaigns[agent] = [];
        if (!agentCampaigns[agent].find(function(x){ return x.campaignId === c.campaignId; })) {
          agentCampaigns[agent].push(campHistory[c.campaignId]);
        }
      });
    });

    const today = new Date().toISOString().split('T')[0];

    for (const agentName of Object.keys(agentCampaigns)) {
      const agentCamps = agentCampaigns[agentName];
      const openTasksRes = await db.query(
        'SELECT COUNT(*) as cnt FROM campaign_tasks WHERE agent_name=$1 AND status IN ($2,$3) AND task_source=$4',
        [agentName, 'open', 'in_progress', 'daily']
      );
      const openCount = parseInt(openTasksRes.rows[0].cnt || 0);
      if (openCount >= 10) { console.log(agentName + ' already has ' + openCount + ' open tasks - skipping'); continue; }

      const slotsAvailable = Math.min(5, 10 - openCount);
      if (slotsAvailable <= 0) continue;

      const scored = [];
      agentCamps.forEach(function(camp) {
        if (!camp.days.length) return;
        const scoring = scoreCampaignDays(camp.days);
        if (scoring.score === 0) return;
        let problemType = 'investigation';
        let problemDetail = '';
        if (scoring.noActivityDays >= 1) { problemType = 'no_activity'; problemDetail = scoring.noActivityDays + ' day(s) zero impressions'; }
        else if (scoring.noRevDays >= 1) { problemType = 'no_revenue'; problemDetail = '£' + scoring.totalSpend + ' spent over ' + camp.days.length + ' day(s) with zero revenue'; }
        else if (parseFloat(scoring.avgAcos) > 35) { problemType = 'high_acos'; problemDetail = scoring.avgAcos + '% avg ACOS over ' + camp.days.length + ' day(s), spend £' + scoring.totalSpend; }
        scored.push({ camp: camp, score: scoring.score, problemType: problemType, problemDetail: problemDetail, scoring: scoring });
      });

      scored.sort(function(a,b){ return b.score - a.score; });
      let newTasksCreated = 0;

      for (const item of scored) {
        if (newTasksCreated >= slotsAvailable) break;
        const c = item.camp;
        const existingToday = await db.query(
          'SELECT id FROM campaign_tasks WHERE campaign_id=$1 AND created_date=$2 AND task_source=$3',
          [String(c.campaignId), today, 'daily']
        );
        if (existingToday.rows.length > 0) continue;

        const prevTask = await db.query(
          'SELECT id, days_persisted FROM campaign_tasks WHERE campaign_id=$1 AND status IN ($2,$3) AND task_source=$4 ORDER BY created_date DESC LIMIT 1',
          [String(c.campaignId), 'open', 'in_progress', 'daily']
        );

        let daysPersisted = 1;
        let isSuperUrgent = false;

        if (prevTask.rows.length > 0) {
          daysPersisted = (prevTask.rows[0].days_persisted || 1) + 1;
          isSuperUrgent = daysPersisted >= 3;
          await db.query('UPDATE campaign_tasks SET days_persisted=$1, score=$2, updated_at=NOW() WHERE id=$3', [daysPersisted, item.score, prevTask.rows[0].id]);
          if (isSuperUrgent) {
            await sendGoogleChat(['🚨 SUPER URGENT - Day ' + daysPersisted + ' UNRESOLVED', 'Campaign: ' + c.name, 'Agent: ' + agentName, 'Problem: ' + item.problemDetail, 'Score: ' + item.score, 'This has been unresolved for ' + daysPersisted + ' days - manager action needed'].join('\n'));
          }
        }

        let isRepeatOffender = false;
        let failureCount = 1;
        try {
          const repeatCheck = await db.query(
            "SELECT id, failure_count FROM campaign_tasks WHERE campaign_id=$1 AND status='complete' AND last_resolved_date > NOW() - INTERVAL '14 days' ORDER BY last_resolved_date DESC LIMIT 1",
            [String(c.campaignId)]
          );
          if (repeatCheck.rows.length > 0) { isRepeatOffender = true; failureCount = (repeatCheck.rows[0].failure_count || 1) + 1; console.log('REPEAT OFFENDER detected: ' + c.name + ' (failure #' + failureCount + ')'); }
        } catch(e) { console.error('Repeat check error: ' + e.message); }

        await db.query(
          'INSERT INTO campaign_tasks (campaign_id, campaign_name, agent_name, portfolio, problem_type, problem_detail, days_persisted, total_wasted, score, task_source, is_repeat_offender, failure_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
          [String(c.campaignId), c.name, agentName, c.portfolio||'', item.problemType, item.problemDetail, daysPersisted, parseFloat(item.scoring.totalSpend), item.score, 'daily', isRepeatOffender, failureCount]
        );

        try {
          await db.query(
            'INSERT INTO activity_log (campaign_id, campaign_name, agent_name, action, notes, status_before, status_after) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [String(c.campaignId), c.name, agentName, 'task_created', item.problemDetail + (isRepeatOffender ? ' [REPEAT OFFENDER #' + failureCount + ']' : ''), 'none', 'open']
          );
        } catch(e) { console.error('Activity log create error: ' + e.message); }

        const urgencyLabel = isSuperUrgent ? '🚨 SUPER URGENT - Day ' + daysPersisted : (daysPersisted > 1 ? '⚠ Day ' + daysPersisted + ' - Unresolved' : '📋 New Task');
        const msg = [urgencyLabel, 'Campaign: ' + c.name, 'Problem: ' + item.problemDetail, 'Score: ' + item.score + ' (higher = more urgent)', '', dashUrl + '/tasks'].join('\n');
        const sent = await sendToAgent(agentName, msg);
        if (!sent) console.log('No webhook for ' + agentName + ' - task created silently');

        newTasksCreated++;
        console.log('Daily task created for ' + agentName + ': ' + c.name + ' (Day ' + daysPersisted + ', score ' + item.score + ')');
      }
      console.log(agentName + ': ' + newTasksCreated + ' new tasks created, ' + openCount + ' already open');
    }
    console.log('Daily task scheduler complete');
  } catch(e) { console.error('Task scheduler error: ' + e.message); }
}

// ── API Routes ────────────────────────────────────────────────────────────
app.get('/api/dashboard', async function(req, res) {
  const campaigns = state.campaigns;
  const totalRevenue = campaigns.reduce(function(s, c) { return s + (c.sales || 0); }, 0);
  const totalSpend = campaigns.reduce(function(s, c) { return s + (c.spend || 0); }, 0);
  const blendedAcos = totalRevenue > 0 ? Math.round((totalSpend / totalRevenue) * 1000) / 10 : 0;
  const active = campaigns.filter(function(c) { return c.state === 'enabled'; }).length;
  const needsAction = campaigns.filter(function(c) { return c.budgetRemaining <= 0.01 || c.acos > parseFloat(process.env.ACOS_CRITICAL_THRESHOLD || 35) || c.budgetPct >= 80; }).length;

  let filteredAlerts = state.alerts.slice(-20);
  if (db) {
    try {
      const dismissed = await db.query("SELECT campaign_id FROM campaign_tasks WHERE task_source='alert' AND status='dismissed' AND DATE(updated_at)=CURRENT_DATE");
      const dismissedIds = new Set(dismissed.rows.map(function(r){ return String(r.campaign_id); }));
      if (dismissedIds.size > 0) filteredAlerts = filteredAlerts.filter(function(a){ return !dismissedIds.has(String(a.campaignId)); });
    } catch(e) {}
  }

  res.json({
    metrics: { totalRevenue: totalRevenue.toFixed(2), totalSpend: totalSpend.toFixed(2), blendedAcos: blendedAcos, activeCampaigns: active, needsAction: needsAction },
    campaigns: campaigns, alerts: filteredAlerts, exhaustionLog: state.exhaustionLog, lastSync: state.lastSync, error: state.error
  });
});

app.post('/api/ai/analyse', async function(req, res) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ error: 'No API key', result: null });
    const acosTarget = parseFloat(process.env.ACOS_WARNING_THRESHOLD || 12);
    const acosCritical = parseFloat(process.env.ACOS_CRITICAL_THRESHOLD || 35);

    let historicalSummary = '';
    let campHistory = {};
    if (db) {
      try {
        const result = await db.query('SELECT snapshot_date, metrics, campaigns FROM daily_snapshots ORDER BY snapshot_date DESC LIMIT 7');
        if (result.rows.length > 0) {
          result.rows.forEach(function(snap) {
            const camps = snap.campaigns || [];
            camps.forEach(function(c) {
              if (!campHistory[c.campaignId]) campHistory[c.campaignId] = { name: c.name, portfolio: c.portfolio||'', days: [] };
              campHistory[c.campaignId].days.push({ date: snap.snapshot_date, spend: c.spend||0, sales: c.sales||0, acos: c.acos||0, impressions: c.impressions||0, budget: c.dailyBudget||0 });
            });
          });
          const metrics = result.rows[0].metrics || {};
          historicalSummary = 'Historical data available: ' + result.rows.length + ' days. Latest day: Revenue £' + metrics.totalRevenue + ', Spend £' + metrics.totalSpend + ', ACOS ' + metrics.blendedAcos + '%, Wasted spend £' + metrics.totalWastedSpend;
        }
      } catch(e) { console.error('AI history fetch: ' + e.message); }
    }

    const scaleList = [], pauseList = [], reduceList = [];
    Object.values(campHistory).forEach(function(camp) {
      const days = camp.days;
      if (!days.length) return;
      const spendDays = days.filter(function(d){ return d.spend > 0; });
      if (!spendDays.length) return;
      const avgAcos = spendDays.reduce(function(s,d){ return s+d.acos; }, 0) / spendDays.length;
      const totalSpend = days.reduce(function(s,d){ return s+d.spend; }, 0);
      const totalSales = days.reduce(function(s,d){ return s+d.sales; }, 0);
      const noRevDays = spendDays.filter(function(d){ return d.sales === 0; }).length;
      const noActDays = days.filter(function(d){ return d.impressions === 0; }).length;
      const avgBudget = spendDays.reduce(function(s,d){ return s+d.budget; }, 0) / spendDays.length;
      if (noActDays >= 3) { pauseList.push({ name: camp.name, portfolio: camp.portfolio, reason: 'Zero impressions for ' + noActDays + ' days', action: 'Pause and review targeting', spend: totalSpend.toFixed(2), acos: '—' }); }
      else if (noRevDays >= 5 && totalSpend > 10) { pauseList.push({ name: camp.name, portfolio: camp.portfolio, reason: noRevDays + ' days spend with zero revenue, £' + totalSpend.toFixed(2) + ' wasted', action: 'Pause campaign', spend: totalSpend.toFixed(2), acos: avgAcos.toFixed(1) + '%' }); }
      else if (avgAcos > acosCritical && spendDays.length >= 3) { reduceList.push({ name: camp.name, portfolio: camp.portfolio, reason: avgAcos.toFixed(1) + '% avg ACOS over ' + spendDays.length + ' days (target: ' + acosTarget + '%)', action: 'Reduce bids by 20% or add negative keywords', spend: totalSpend.toFixed(2), acos: avgAcos.toFixed(1) + '%' }); }
      else if (avgAcos > 0 && avgAcos < acosTarget && totalSales > 20 && spendDays.length >= 3) { scaleList.push({ name: camp.name, portfolio: camp.portfolio, reason: avgAcos.toFixed(1) + '% avg ACOS over ' + spendDays.length + ' days, £' + totalSales.toFixed(2) + ' revenue', action: 'Increase daily budget from £' + avgBudget.toFixed(2) + ' to £' + (avgBudget * 1.5).toFixed(2), spend: totalSpend.toFixed(2), acos: avgAcos.toFixed(1) + '%' }); }
    });

    if (!Object.keys(campHistory).length) {
      const allCamps = state.campaigns;
      allCamps.forEach(function(c) {
        if (c.acos > 0 && c.acos < acosTarget && c.sales > 5) scaleList.push({ name: c.name, portfolio: c.portfolio||'', reason: c.acos + '% ACOS today', action: 'Increase daily budget from £' + c.dailyBudget + ' to £' + (c.dailyBudget * 1.5).toFixed(2), spend: (c.spend||0).toString(), acos: c.acos + '%' });
        else if (c.acos > acosCritical && c.spend > 5) reduceList.push({ name: c.name, portfolio: c.portfolio||'', reason: c.acos + '% ACOS today', action: 'Reduce bids or add negative keywords', spend: (c.spend||0).toString(), acos: c.acos + '%' });
      });
    }

    let strategicInsight = '';
    if (apiKey && (scaleList.length || pauseList.length || reduceList.length)) {
      const prompt = ['You are an Amazon Advertising expert for FK Sports UK (sports equipment). ACOS target is ' + acosTarget + '%.', historicalSummary, 'Scale candidates (' + scaleList.length + '): ' + scaleList.slice(0,5).map(function(c){ return c.name + ' (' + c.acos + ')'; }).join(', '), 'Pause candidates (' + pauseList.length + '): ' + pauseList.slice(0,5).map(function(c){ return c.name; }).join(', '), 'Reduce budget candidates (' + reduceList.length + '): ' + reduceList.slice(0,5).map(function(c){ return c.name + ' (' + c.acos + ')'; }).join(', '), 'In 3-4 sentences give ONE strategic insight about FK Sports campaign performance that would not be obvious from looking at individual campaigns. Focus on patterns, seasonality, or structural issues. Be specific and actionable.'].join(' ');
      try {
        const aiRes = await axios.post('https://api.anthropic.com/v1/messages', { model: 'claude-opus-4-5-20251101', max_tokens: 500, messages: [{ role: 'user', content: prompt }] }, { headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
        strategicInsight = aiRes.data.content[0].text;
      } catch(e) { console.error('AI insight error: ' + e.message); }
    }

    res.json({ result: { scaleList, pauseList, reduceList, strategicInsight, acosTarget, daysOfData: Object.values(campHistory)[0]?.days?.length || 0 } });
  } catch(e) { console.error('AI error: ' + e.message); res.json({ error: e.message, result: null }); }
});

// ── Keyword Intelligence ─────────────────────────────────────────────────
let keywordState = { reportId: null, requested: 0, data: null, analysis: null, lastAnalysed: 0 };

async function requestSearchTermReport() {
  const now = Date.now();
  if (keywordState.reportId || (now - keywordState.requested) < 7 * 24 * 60 * 60 * 1000) return;
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const headers = getHeaders(profileId, token);
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  try {
    const res = await axios.post('https://advertising-api-eu.amazon.com/reporting/reports', { name: 'CampaignPulse Search Terms ' + today, startDate: weekAgo, endDate: today, configuration: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['searchTerm'], columns: ['campaignId', 'campaignName', 'adGroupId', 'adGroupName', 'keywordId', 'keyword', 'matchType', 'searchTerm', 'cost', 'clicks', 'impressions', 'purchases14d', 'sales14d'], reportTypeId: 'spSearchTerm', timeUnit: 'SUMMARY', format: 'GZIP_JSON' } }, { headers: Object.assign({}, headers, { 'Content-Type': 'application/json', 'Accept': 'application/json' }) });
    keywordState.reportId = res.data.reportId;
    keywordState.requested = now;
    console.log('Search term report requested: ' + keywordState.reportId);
  } catch(e) { console.error('Search term report error: ' + e.message); }
}

async function checkSearchTermReport() {
  if (!keywordState.reportId) return;
  const token = await getAccessToken();
  const profileId = await getProfileId();
  const headers = getHeaders(profileId, token);
  try {
    const statusRes = await axios.get('https://advertising-api-eu.amazon.com/reporting/reports/' + keywordState.reportId, { headers: Object.assign({}, headers, { 'Accept': 'application/json' }) });
    const status = statusRes.data.status;
    console.log('Search term report status: ' + status);
    if (status === 'COMPLETED') {
      const downloadRes = await axios.get(statusRes.data.url, { responseType: 'arraybuffer' });
      const zlib = require('zlib');
      const decompressed = zlib.gunzipSync(Buffer.from(downloadRes.data));
      keywordState.data = JSON.parse(decompressed.toString());
      keywordState.reportId = null;
      console.log('Search term report downloaded: ' + keywordState.data.length + ' records');
      await analyseKeywords();
    } else if (status === 'FAILED') { console.log('Search term report failed'); keywordState.reportId = null; }
  } catch(e) { console.error('Search term check error: ' + e.message); keywordState.reportId = null; }
}

async function analyseKeywords() {
  if (!keywordState.data || !keywordState.data.length) return;
  if (!process.env.ANTHROPIC_API_KEY) { keywordState.analysis = ruleBasedKeywordAnalysis(keywordState.data); return; }
  try {
    const data = keywordState.data;
    const wasters = data.filter(function(r){ return parseFloat(r.cost||0) > 5 && parseInt(r.purchases14d||0) === 0 && parseInt(r.clicks||0) > 3; }).sort(function(a,b){ return parseFloat(b.cost||0) - parseFloat(a.cost||0); }).slice(0, 20);
    const converters = data.filter(function(r){ return parseInt(r.purchases14d||0) > 0 && r.matchType !== 'EXACT'; }).sort(function(a,b){ return parseInt(b.purchases14d||0) - parseInt(a.purchases14d||0); }).slice(0, 20);
    const autoWasters = wasters.filter(function(r){ return (r.campaignName||'').toLowerCase().includes('auto'); });
    const manualWasters = wasters.filter(function(r){ return !(r.campaignName||'').toLowerCase().includes('auto'); });
    const autoConverters = converters.filter(function(r){ return (r.campaignName||'').toLowerCase().includes('auto'); });
    const manualConverters = converters.filter(function(r){ return !(r.campaignName||'').toLowerCase().includes('auto'); });
    const totalWastedSpend = wasters.reduce(function(s,r){ return s+parseFloat(r.cost||0); }, 0);
    const totalConvValue = converters.reduce(function(s,r){ return s+parseFloat(r.sales14d||0); }, 0);

    let dismissedLines = '';
    try {
      const dismissed = await db.query('SELECT search_term, campaign, reason FROM keyword_dismissals ORDER BY dismissed_at DESC LIMIT 100');
      if (dismissed.rows.length > 0) dismissedLines = 'PREVIOUSLY DISMISSED KEYWORDS (do NOT recommend these again):\n' + dismissed.rows.map(function(d){ return d.search_term + ' | Campaign: ' + d.campaign + ' | Reason: ' + d.reason; }).join('\n') + '\n';
    } catch(e) {}

    const NL = '\n';
    const wasteAutoLines = autoWasters.slice(0,25).map(function(r){ return r.searchTerm + ' | £' + parseFloat(r.cost||0).toFixed(2) + ' | ' + (r.clicks||0) + ' clicks | ' + r.campaignName; }).join(NL);
    const wasteManualLines = manualWasters.slice(0,25).map(function(r){ return r.searchTerm + ' | £' + parseFloat(r.cost||0).toFixed(2) + ' | ' + (r.clicks||0) + ' clicks | ' + r.campaignName; }).join(NL);
    const convAutoLines = autoConverters.slice(0,25).map(function(r){ return r.searchTerm + ' | ' + r.purchases14d + ' purchases | £' + parseFloat(r.sales14d||0).toFixed(2) + ' | ' + (r.matchType||'') + ' | ' + r.campaignName; }).join(NL);
    const convManualLines = manualConverters.slice(0,25).map(function(r){ return r.searchTerm + ' | ' + r.purchases14d + ' purchases | £' + parseFloat(r.sales14d||0).toFixed(2) + ' | ' + (r.matchType||'') + ' | ' + r.campaignName; }).join(NL);
    const jsonFmt = '{"wasteReduction":{"totalWasted":"£X","estimatedSaving":"£X/week","topWasters":[{"searchTerm":"","campaign":"","campaignType":"auto or manual","spend":"£X","clicks":0,"recommendation":"","reason":""}]},"newKeywords":{"totalOpportunities":0,"estimatedRevenue":"£X/week","topOpportunities":[{"searchTerm":"","campaign":"","campaignType":"auto or manual","purchases":0,"sales":"£X","matchType":"","recommendation":"","estimatedImpact":""}]},"patterns":{"wastePatterns":"","keyInsight":""},"structuralChange":{"recommendation":"","expectedImpact":"","priority":"high"},"summary":"","estimatedWeeklyImpact":"£X"}';
    const prompt = ['You are an Amazon Advertising expert for FK Sports UK (fitness equipment).', 'Analyse 7-day search term data. Total: ' + data.length + ' terms. Wasted: £' + totalWastedSpend.toFixed(2) + '. Converting value: £' + totalConvValue.toFixed(2), '', 'WASTING TERMS AUTO (' + autoWasters.length + '):', wasteAutoLines, 'WASTING TERMS MANUAL (' + manualWasters.length + '):', wasteManualLines, '', 'CONVERTING NOT EXACT - AUTO (' + autoConverters.length + '):', convAutoLines, 'CONVERTING NOT EXACT - MANUAL (' + manualConverters.length + '):', convManualLines, '', dismissedLines, 'Q1: Which terms need NEGATIVE KEYWORDS?', 'Q2: Which converting terms become EXACT MATCH?', 'Q3: Patterns in wasting terms?', 'Q4: Single most impactful structural change?', '', 'Return ONLY valid JSON, no other text:', jsonFmt].join(NL);

    const aiRes = await axios.post('https://api.anthropic.com/v1/messages', { model: 'claude-opus-4-5-20251101', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }, { headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } });
    const text = aiRes.data.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const jsonStart = clean.indexOf('{');
    const jsonEnd = clean.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON found in response');
    const parsed = JSON.parse(clean.substring(jsonStart, jsonEnd + 1));
    keywordState.analysis = { wasteReduction: parsed.wasteReduction || {}, newKeywords: parsed.newKeywords || {}, bidChanges: parsed.bidChanges || [], portfolioInsights: { patterns: (parsed.patterns && parsed.patterns.keyInsight) || (parsed.portfolioInsights && parsed.portfolioInsights.patterns) || '', topPerforming: (parsed.portfolioInsights && parsed.portfolioInsights.topPerforming) || '', needsAttention: (parsed.portfolioInsights && parsed.portfolioInsights.needsAttention) || '' }, structuralChange: parsed.structuralChange || null, summary: parsed.summary || '', estimatedWeeklyImpact: parsed.estimatedWeeklyImpact || '' };
    keywordState.lastAnalysed = Date.now();
    console.log('Keyword AI analysis complete');
  } catch(e) { console.error('Keyword analysis error: ' + e.message); keywordState.analysis = ruleBasedKeywordAnalysis(keywordState.data); }
}

function ruleBasedKeywordAnalysis(data) {
  const wasters = data.filter(function(r){ return parseFloat(r.cost||0) > 5 && parseInt(r.purchases14d||0) === 0 && parseInt(r.clicks||0) > 3; }).sort(function(a,b){ return parseFloat(b.cost||0) - parseFloat(a.cost||0); }).slice(0, 10);
  const converters = data.filter(function(r){ return parseInt(r.purchases14d||0) > 0 && r.matchType !== 'EXACT'; }).sort(function(a,b){ return parseInt(b.purchases14d||0) - parseInt(a.purchases14d||0); }).slice(0, 10);
  const totalWasted = wasters.reduce(function(s,r){ return s + parseFloat(r.cost||0); }, 0);
  return { wasteReduction: { totalWasted: '£' + totalWasted.toFixed(2), topWasters: wasters.map(function(r){ return { searchTerm: r.searchTerm, campaign: r.campaignName, spend: '£' + parseFloat(r.cost||0).toFixed(2), recommendation: 'Add as negative keyword', reason: 'Zero conversions after £' + parseFloat(r.cost||0).toFixed(2) + ' spend' }; }), estimatedSaving: '£' + totalWasted.toFixed(2) + '/week' }, newKeywords: { totalOpportunities: converters.length, topOpportunities: converters.map(function(r){ return { searchTerm: r.searchTerm, campaign: r.campaignName, purchases: r.purchases14d, sales: '£' + parseFloat(r.sales14d||0).toFixed(2), recommendation: 'Add as exact match keyword', estimatedImpact: 'Lower ACOS, more targeted traffic' }; }) }, bidChanges: [], portfolioInsights: { patterns: 'Analysis based on last 7 days of search term data', topPerforming: converters[0] ? converters[0].campaignName : 'N/A', needsAttention: wasters[0] ? wasters[0].campaignName : 'N/A' }, summary: 'Found ' + wasters.length + ' wasting search terms and ' + converters.length + ' new keyword opportunities.', estimatedWeeklyImpact: '£' + totalWasted.toFixed(2) + ' saved' };
}

app.get('/api/keywords/status', function(req, res) { res.json({ reportId: keywordState.reportId, hasData: !!keywordState.data, dataSize: keywordState.data ? keywordState.data.length : 0, hasAnalysis: !!keywordState.analysis, lastAnalysed: keywordState.lastAnalysed, requested: keywordState.requested }); });
app.get('/api/keywords/analysis', function(req, res) { res.json({ analysis: keywordState.analysis, dataSize: keywordState.data ? keywordState.data.length : 0 }); });
app.post('/api/keywords/refresh', async function(req, res) { keywordState.requested = 0; keywordState.reportId = null; await requestSearchTermReport(); res.json({ success: true, reportId: keywordState.reportId }); });

app.post('/api/keywords/dismiss', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  const { searchTerm, campaign, reason, dismissedBy } = req.body;
  if (!searchTerm || !campaign || !reason) return res.status(400).json({ error: 'searchTerm, campaign and reason required' });
  try {
    await db.query('INSERT INTO keyword_dismissals (search_term, campaign, reason, dismissed_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [searchTerm, campaign, reason, dismissedBy || 'unknown']);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/keywords/dismissals', async function(req, res) {
  if (!db) return res.json({ dismissals: [] });
  try {
    const result = await db.query('SELECT search_term, campaign, reason, dismissed_by, dismissed_at FROM keyword_dismissals ORDER BY dismissed_at DESC');
    res.json({ dismissals: result.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/activity', async function(req, res) {
  if (!db) return res.json({ logs: [] });
  try {
    const agent = req.query.agent || '';
    const limit = parseInt(req.query.limit) || 100;
    let query = 'SELECT * FROM activity_log';
    let params = [];
    if (agent) { query += ' WHERE agent_name=$1'; params.push(agent); }
    query += ' ORDER BY logged_at DESC LIMIT ' + limit;
    const result = await db.query(query, params);
    res.json({ logs: result.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

let agentPerfCache = { data: null, generated: 0 };
app.get('/api/agent-performance', async function(req, res) {
  if (!db) return res.json({ analysis: 'No database available.' });
  if (agentPerfCache.data && Date.now() - agentPerfCache.generated < 60 * 60 * 1000) return res.json({ analysis: agentPerfCache.data, cached: true });
  try {
    const logs = await db.query("SELECT agent_name, action, notes, status_before, status_after, campaign_name, logged_at FROM activity_log WHERE logged_at > NOW() - INTERVAL '30 days' ORDER BY logged_at DESC LIMIT 500");
    const repeats = await db.query("SELECT campaign_name, agent_name, failure_count FROM campaign_tasks WHERE is_repeat_offender=TRUE ORDER BY failure_count DESC LIMIT 20");
    const summary = await db.query("SELECT agent_name, status, COUNT(*) as count FROM campaign_tasks WHERE created_date > NOW() - INTERVAL '30 days' GROUP BY agent_name, status ORDER BY agent_name, status");
    const alertResponses = await db.query("SELECT agent_name, action, COUNT(*) as count FROM activity_log WHERE action IN ('budget_added','alert_dismissed','alert_ignored') AND logged_at > NOW() - INTERVAL '30 days' GROUP BY agent_name, action ORDER BY agent_name");
    const kwActions = await db.query("SELECT dismissed_by as agent_name, reason, COUNT(*) as count FROM keyword_dismissals WHERE dismissed_at > NOW() - INTERVAL '30 days' GROUP BY dismissed_by, reason ORDER BY dismissed_by");
    const prompt = 'You are analyzing Amazon PPC campaign management performance for FK Sports.\n\nAGENT ACTIVITY LOG (last 30 days):\n' + JSON.stringify(logs.rows, null, 2) + '\n\nREPEAT OFFENDERS:\n' + JSON.stringify(repeats.rows, null, 2) + '\n\nTASK SUMMARY PER AGENT:\n' + JSON.stringify(summary.rows, null, 2) + '\n\nALERT RESPONSE TRACKING:\n' + JSON.stringify(alertResponses.rows, null, 2) + '\n\nKEYWORD ACTIONS PER AGENT:\n' + JSON.stringify(kwActions.rows, null, 2) + '\n\nAnalyze each agent (Aryan, Satyam, Kunal) performance. For each agent provide:\n1. Overall performance rating (Strong/Average/Needs Improvement)\n2. Tasks completed vs abandoned vs dismissed\n3. Alert response rate\n4. Patterns in their notes\n5. Repeat offender campaigns they own\n6. Keyword intelligence actions\n7. One specific actionable recommendation\n\nBe direct and honest. 4-5 sentences per agent.';
    const response = await axios.post('https://api.anthropic.com/v1/messages', { model: 'claude-opus-4-5-20251101', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });
    const analysis = response.data.content[0].text;
    agentPerfCache = { data: analysis, generated: Date.now() };
    res.json({ analysis });
  } catch(e) { console.error('Agent perf error: ' + e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async function(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const result = await db.query('SELECT * FROM users WHERE email=$1 AND is_active=TRUE', [email.toLowerCase().trim()]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid email or password' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    const token = uuidv4() + uuidv4();
    await db.query("INSERT INTO user_sessions (user_id, token, department, role, name, email, expires_at) VALUES ($1,$2,$3,$4,$5,$6,NOW() + INTERVAL '24 hours')", [user.id, token, user.department, user.role, user.name, user.email]);
    await db.query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);
    res.json({ success: true, token, name: user.name, department: user.department, role: user.role, email: user.email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', async function(req, res) {
  const token = req.headers['x-auth-token'] || '';
  if (token && db) { try { await db.query('DELETE FROM user_sessions WHERE token=$1', [token]); } catch(e) {} }
  res.json({ success: true });
});

app.get('/api/auth/me', async function(req, res) {
  const token = req.headers['x-auth-token'] || '';
  if (!token || !db) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await db.query('SELECT * FROM user_sessions WHERE token=$1 AND expires_at > NOW()', [token]);
    if (!result.rows.length) return res.status(401).json({ error: 'Session expired' });
    const s = result.rows[0];
    res.json({ name: s.name, department: s.department, role: s.role, email: s.email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/users', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  const { name, email, password, department, role } = req.body;
  if (!name || !email || !password || !department) return res.status(400).json({ error: 'All fields required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO users (name, email, password_hash, department, role) VALUES ($1,$2,$3,$4,$5)', [name, email.toLowerCase().trim(), hash, department, role||'agent']);
    res.json({ success: true });
  } catch(e) { if (e.code === '23505') return res.status(400).json({ error: 'Email already exists' }); res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/users', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const result = await db.query('SELECT id, name, email, department, role, is_active, created_at, last_login FROM users ORDER BY department, name');
    res.json({ users: result.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/change-password', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  const token = req.headers['x-auth-token'] || '';
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const sessionRes = await db.query('SELECT * FROM user_sessions WHERE token=$1 AND expires_at > NOW()', [token]);
    if (!sessionRes.rows.length) return res.status(401).json({ error: 'Not authenticated' });
    const userId = sessionRes.rows[0].user_id;
    const userRes = await db.query('SELECT * FROM users WHERE id=$1', [userId]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, userRes.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/auth/users/:id', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  const { name, department, role, is_active, password } = req.body;
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET name=$1, department=$2, role=$3, is_active=$4, password_hash=$5 WHERE id=$6', [name, department, role, is_active, hash, req.params.id]);
    } else {
      await db.query('UPDATE users SET name=$1, department=$2, role=$3, is_active=$4 WHERE id=$5', [name, department, role, is_active, req.params.id]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

cron.schedule('0 3 * * *', async function() {
  if (db) { try { await db.query('DELETE FROM user_sessions WHERE expires_at < NOW()'); } catch(e) { console.error('Session cleanup error: ' + e.message); } }
}, { timezone: 'Europe/London' });

app.get('/api/admin/create-manager', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const hash = await bcrypt.hash('FKSports2024!', 10);
    await db.query('INSERT INTO users (name, email, password_hash, department, role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO UPDATE SET password_hash=$3, is_active=TRUE', ['Bobby', 'bobby@fksports.co.uk', hash, 'manager', 'manager']);
    res.json({ success: true, message: 'Manager account created/reset. Email: bobby@fksports.co.uk / Password: FKSports2024!' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/fix-agent-names', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  const knownAgents = ['Aryan', 'Satyam', 'Kunal'];
  try {
    const tasks = await db.query("SELECT id, campaign_name FROM campaign_tasks WHERE (agent_name IS NULL OR agent_name NOT IN ('Aryan','Satyam','Kunal'))");
    let fixed = 0, deleted = 0;
    for (const row of tasks.rows) {
      const parts = (row.campaign_name || '').split(/[|@]/);
      const extracted = parts[0].trim().substring(0, 30);
      if (knownAgents.includes(extracted)) { await db.query('UPDATE campaign_tasks SET agent_name=$1 WHERE id=$2', [extracted, row.id]); fixed++; }
      else { await db.query('DELETE FROM campaign_tasks WHERE id=$1', [row.id]); deleted++; }
    }
    res.json({ success: true, fixed, deleted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tasks/:id/escalation-analysis', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const taskRes = await db.query('SELECT * FROM campaign_tasks WHERE id=$1', [req.params.id]);
    const task = taskRes.rows[0];
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const history = await db.query('SELECT action, notes, logged_at FROM activity_log WHERE task_id=$1 ORDER BY logged_at ASC', [task.id]);
    const snapshots = await db.query("SELECT snapshot_date, campaigns FROM daily_snapshots WHERE snapshot_date > NOW() - INTERVAL '7 days' ORDER BY snapshot_date DESC LIMIT 7");
    let campHistory = [];
    snapshots.rows.forEach(function(snap) {
      const c = (snap.campaigns||[]).find(function(x){ return String(x.campaignId) === String(task.campaign_id); });
      if (c) campHistory.push({ date: snap.snapshot_date, spend: c.spend, sales: c.sales, acos: c.acos, impressions: c.impressions });
    });
    const prompt = 'You are analyzing an Amazon PPC campaign task escalated after ' + task.days_persisted + ' days.\n\nCAMPAIGN: ' + task.campaign_name + '\nAGENT: ' + task.agent_name + '\nPROBLEM: ' + task.problem_detail + '\nDAYS OPEN: ' + task.days_persisted + '\nSCORE: ' + task.score + '\nREPEAT OFFENDER: ' + (task.is_repeat_offender ? 'YES - has failed ' + task.failure_count + ' times' : 'No') + '\n\nAGENT NOTES HISTORY:\n' + JSON.stringify(history.rows, null, 2) + '\n\nCAMPAIGN PERFORMANCE (last 7 days):\n' + JSON.stringify(campHistory, null, 2) + '\n\nProvide:\n1. Root cause analysis\n2. Is the agent\'s approach working?\n3. Specific recommended fix\n4. If agent requests 7-day scaling window - justified? Yes/No with reason.\n\nBe direct, specific, actionable. 3-4 sentences max per point.';
    const response = await axios.post('https://api.anthropic.com/v1/messages', { model: 'claude-opus-4-5-20251101', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });
    res.json({ analysis: response.data.content[0].text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/snapshots', async function(req, res) {
  const dates = await getSnapshotDates();
  res.json({ dates: dates.map(function(r) { const d = typeof r.snapshot_date === 'string' ? r.snapshot_date : new Date(r.snapshot_date).toISOString().split('T')[0]; return { date: d, metrics: r.metrics }; })});
});

app.post('/api/tasks/:id/reopen', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const taskRes = await db.query('SELECT * FROM campaign_tasks WHERE id=$1', [req.params.id]);
    if (!taskRes.rows.length) return res.status(404).json({ error: 'Task not found' });
    const task = taskRes.rows[0];
    await db.query('UPDATE campaign_tasks SET status=$1, resolved_at=NULL, updated_at=NOW() WHERE id=$2', ['open', req.params.id]);
    const agentName = (task.agent_name && ['Aryan','Satyam','Kunal'].includes(task.agent_name)) ? task.agent_name : extractAgentFromCampaign(task.campaign_name||'') || 'Unknown';
    await db.query('INSERT INTO activity_log (campaign_id, campaign_name, agent_name, action, notes, status_before, status_after, task_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [task.campaign_id||'', task.campaign_name||'', agentName, 'reopened', 'Task reopened — moved back to Due', task.status, 'open', parseInt(req.params.id)]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tasks/:id/toggle-note', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const taskRes = await db.query('SELECT notes_ignored FROM campaign_tasks WHERE id=$1', [req.params.id]);
    if (!taskRes.rows.length) return res.status(404).json({ error: 'Task not found' });
    const currentIgnored = taskRes.rows[0].notes_ignored || false;
    await db.query('UPDATE campaign_tasks SET notes_ignored=$1, updated_at=NOW() WHERE id=$2', [!currentIgnored, req.params.id]);
    res.json({ success: true, notes_ignored: !currentIgnored });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stuck-campaigns/action', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  const { campaignId, campaignName, action, notes } = req.body;
  if (!campaignId || !action || !notes) return res.status(400).json({ error: 'Missing fields' });
  try {
    const agentName = extractAgentFromCampaign(campaignName||'') || 'Unknown';
    if (action === 'review') {
      const flagDeadline = new Date(); flagDeadline.setDate(flagDeadline.getDate() + 7);
      await db.query('INSERT INTO activity_log (campaign_id, campaign_name, agent_name, action, notes) VALUES ($1,$2,$3,$4,$5)', [String(campaignId), campaignName, agentName, 'stuck_flagged_1week', 'Agent will work on this for 1 week. Plan: ' + notes + '. Deadline: ' + flagDeadline.toLocaleDateString('en-GB')]);
    } else if (action === 'pause') {
      await db.query('INSERT INTO activity_log (campaign_id, campaign_name, agent_name, action, notes) VALUES ($1,$2,$3,$4,$5)', [String(campaignId), campaignName, agentName, 'stuck_paused', 'Campaign paused from underperforming page. Reason: ' + notes]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/activity/log', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  const { campaignId, campaignName, action, notes, agentName } = req.body;
  try {
    const agent = agentName || extractAgentFromCampaign(campaignName||'') || 'Unknown';
    await db.query('INSERT INTO activity_log (campaign_id, campaign_name, agent_name, action, notes) VALUES ($1,$2,$3,$4,$5)', [String(campaignId||''), campaignName||'', agent, action||'', notes||'']);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/campaigns/:id/spend-breakdown', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const campaignId = req.params.id;
    const snapshots = await db.query("SELECT TO_CHAR(snapshot_date, 'YYYY-MM-DD') as snapshot_date, campaigns FROM daily_snapshots WHERE snapshot_date >= CURRENT_DATE - INTERVAL '14 days' ORDER BY snapshot_date DESC LIMIT 14");
    const breakdown = [];
    snapshots.rows.forEach(function(snap) {
      const c = (snap.campaigns||[]).find(function(x){ return String(x.campaignId) === String(campaignId); });
      if (c && (parseFloat(c.spend||0) > 0 || parseFloat(c.sales||0) > 0)) {
        const d = typeof snap.snapshot_date === 'string' ? snap.snapshot_date : new Date(snap.snapshot_date).toLocaleDateString('en-GB', {timeZone:'Europe/London', year:'numeric', month:'2-digit', day:'2-digit'}).split('/').reverse().join('-');
        breakdown.push({ date: d, spend: parseFloat(c.spend||0).toFixed(2), sales: parseFloat(c.sales||0).toFixed(2), acos: c.acos||0, impressions: c.impressions||0, clicks: c.clicks||0 });
      }
    });
    res.json({ breakdown });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/campaign-analysis/:campaignId', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'No API key' });
  try {
    const campaignId = req.params.campaignId;
    const snapshots = await db.query("SELECT TO_CHAR(snapshot_date, 'YYYY-MM-DD') as snapshot_date, campaigns FROM daily_snapshots WHERE snapshot_date >= CURRENT_DATE - INTERVAL '14 days' ORDER BY snapshot_date DESC LIMIT 14");
    let history = [];
    snapshots.rows.forEach(function(snap) {
      const c = (snap.campaigns||[]).find(function(x){ return String(x.campaignId) === String(campaignId); });
      if (c) history.push({ date: snap.snapshot_date, spend: c.spend||0, sales: c.sales||0, acos: c.acos||0, impressions: c.impressions||0, clicks: c.clicks||0 });
    });
    if (!history.length) return res.json({ analysis: 'No historical data found for this campaign.' });
    const totalSpend = history.reduce(function(s,d){ return s+parseFloat(d.spend||0); }, 0);
    const totalSales = history.reduce(function(s,d){ return s+parseFloat(d.sales||0); }, 0);
    const daysNoRevenue = history.filter(function(d){ return parseFloat(d.sales||0) === 0 && parseFloat(d.spend||0) > 0; }).length;
    const daysNoActivity = history.filter(function(d){ return parseInt(d.impressions||0) === 0; }).length;
    const dismissed = await db.query('SELECT search_term, reason FROM keyword_dismissals WHERE campaign ILIKE $1', ['%' + campaignId + '%']);
    const dismissedSection = dismissed.rows.length > 0 ? '\nDISMISSED KEYWORDS:\n' + dismissed.rows.map(function(d){ return d.search_term + ': ' + d.reason; }).join('\n') : '';
    const prompt = 'You are an Amazon PPC expert analyzing a campaign for FK Sports UK (fitness equipment).\n\nCAMPAIGN ID: ' + campaignId + '\nLAST 14 DAYS:\n' + JSON.stringify(history, null, 2) + '\n\nSUMMARY:\n- Total spend: £' + totalSpend.toFixed(2) + '\n- Total revenue: £' + totalSales.toFixed(2) + '\n- Days with spend but zero revenue: ' + daysNoRevenue + '\n- Days with zero impressions: ' + daysNoActivity + dismissedSection + '\n\nProvide:\n1. Likely root cause\n2. One specific recommended action\n3. Worth continuing or pause?\n\nBe direct. No generic advice.';
    const response = await axios.post('https://api.anthropic.com/v1/messages', { model: 'claude-opus-4-5-20251101', max_tokens: 400, messages: [{ role: 'user', content: prompt }] }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });
    res.json({ analysis: response.data.content[0].text, totalSpend, totalSales, daysNoRevenue, daysNoActivity });
  } catch(e) { console.error('Campaign analysis error: ' + e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/stuck-campaigns', async function(req, res) {
  if (!db) return res.json({ noActivity: [], noRevenue: [] });
  try {
    const result = await db.query('SELECT snapshot_date, campaigns FROM daily_snapshots ORDER BY snapshot_date DESC LIMIT 7');
    const snapshots = result.rows;
    if (snapshots.length < 3) return res.json({ noActivity: [], noRevenue: [], days: snapshots.length });
    const campHistory = {};
    snapshots.forEach(function(snap) {
      const camps = snap.campaigns || [];
      const date = snap.snapshot_date;
      camps.forEach(function(c) {
        if (!campHistory[c.campaignId]) campHistory[c.campaignId] = { name: c.name, portfolio: c.portfolio||'', agent: c.agent||'', targetingType: c.targetingType||'', days: [] };
        campHistory[c.campaignId].days.push({ date, impressions: c.impressions||0, spend: c.spend||0, sales: c.sales||0, acos: c.acos||0, dailyBudget: c.dailyBudget||0 });
      });
    });
    const noActivity = [], noRevenue = [];
    Object.values(campHistory).forEach(function(camp) {
      const days = camp.days;
      if (days.length < 3) return;
      const last3 = days.slice(0, 3);
      if (last3.every(function(d){ return d.impressions === 0; })) { const totalSpend = last3.reduce(function(s,d){ return s+d.spend; }, 0); noActivity.push(Object.assign({}, camp, { daysNoActivity: last3.length, totalSpend: totalSpend.toFixed(2), lastBudget: last3[0].dailyBudget })); }
      const last7 = days.slice(0, Math.min(7, days.length));
      const spendDays = last7.filter(function(d){ return d.spend > 0; });
      if (spendDays.length >= 3 && last7.every(function(d){ return d.spend === 0 || d.sales === 0; })) { const totalSpend = last7.reduce(function(s,d){ return s+d.spend; }, 0); const avgAcos = spendDays.length > 0 ? spendDays.reduce(function(s,d){ return s+d.acos; }, 0) / spendDays.length : 0; noRevenue.push(Object.assign({}, camp, { daysNoRevenue: spendDays.length, totalWastedSpend: totalSpend.toFixed(2), avgAcos: avgAcos.toFixed(1) })); }
    });
    noActivity.sort(function(a,b){ return b.daysNoActivity - a.daysNoActivity; });
    noRevenue.sort(function(a,b){ return parseFloat(b.totalWastedSpend) - parseFloat(a.totalWastedSpend); });
    res.json({ noActivity, noRevenue, daysOfData: snapshots.length });
  } catch(e) { console.error('Stuck campaigns error: ' + e.message); res.json({ noActivity: [], noRevenue: [], error: e.message }); }
});

app.get('/api/snapshots/:date', async function(req, res) {
  const snap = await getDailySnapshot(req.params.date);
  if (!snap) return res.status(404).json({ error: 'No snapshot for ' + req.params.date });
  res.json({ date: snap.snapshot_date, metrics: snap.metrics, campaigns: snap.campaigns, exhaustionLog: snap.exhaustion_log, alerts: snap.alerts });
});

app.get('/api/settings', async function(req, res) {
  try { if (!db) return res.json({ settings: null }); const result = await db.query('SELECT settings FROM app_settings WHERE id = 1'); res.json({ settings: result.rows[0]?.settings || {} }); } catch(e) { res.json({ settings: null, error: e.message }); }
});

app.post('/api/settings', async function(req, res) {
  try {
    const { settings } = req.body;
    if (!settings) return res.status(400).json({ error: 'No settings provided' });
    if (db) await db.query('UPDATE app_settings SET settings = $1, updated_at = NOW() WHERE id = 1', [JSON.stringify(settings)]);
    if (settings.acosCritical) process.env.ACOS_CRITICAL_THRESHOLD = String(settings.acosCritical);
    if (settings.acosWarning) process.env.ACOS_WARNING_THRESHOLD = String(settings.acosWarning);
    if (settings.budgetLowPct) process.env.BUDGET_LOW_PERCENT = String(settings.budgetLowPct);
    console.log('Settings updated: ' + JSON.stringify(settings));
    res.json({ success: true });
  } catch(e) { console.error('Settings save error: ' + e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/tasks', async function(req, res) {
  if (!db) return res.json({ tasks: [] });
  try { const result = await db.query("SELECT * FROM campaign_tasks WHERE agent_name IN ('Aryan','Satyam','Kunal') ORDER BY score DESC, created_date DESC LIMIT 500"); res.json({ tasks: result.rows }); } catch(e) { res.json({ tasks: [], error: e.message }); }
});

app.post('/api/admin/cleanup-tasks', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try { const deleted = await db.query("DELETE FROM campaign_tasks WHERE agent_name IS NULL OR agent_name NOT IN ('Aryan','Satyam','Kunal') RETURNING id"); res.json({ success: true, deleted: deleted.rowCount }); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tasks/:id/status', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  const { status, notes, dismissedReason, pausedReason, escalationReason } = req.body;
  try {
    const taskRes = await db.query('SELECT * FROM campaign_tasks WHERE id=$1', [req.params.id]);
    const task = taskRes.rows[0] || {};
    const statusBefore = task.status || 'unknown';
    let query, params;
    if (status === 'dismissed') { const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999); query = 'UPDATE campaign_tasks SET status=$1, agent_notes=$2, dismissed_reason=$3, updated_at=NOW(), resolved_at=NOW(), suppressed_until=$4 WHERE id=$5'; params = [status, notes||'', dismissedReason||notes||'', endOfDay.toISOString(), req.params.id]; }
    else if (status === 'paused') { query = 'UPDATE campaign_tasks SET status=$1, agent_notes=$2, paused_reason=$3, updated_at=NOW(), resolved_at=NOW() WHERE id=$4'; params = [status, notes||pausedReason||'', pausedReason||notes||'', req.params.id]; }
    else if (status === 'in_progress') { query = 'UPDATE campaign_tasks SET status=$1, agent_notes=$2, updated_at=NOW(), first_action_at=COALESCE(first_action_at, NOW()) WHERE id=$3'; params = [status, notes||'', req.params.id]; }
    else if (status === 'scaling') { const deadline = new Date(); deadline.setDate(deadline.getDate() + 7); query = 'UPDATE campaign_tasks SET status=$1, agent_notes=$2, escalation_reason=$3, scaling_deadline=$4, updated_at=NOW(), first_action_at=COALESCE(first_action_at, NOW()) WHERE id=$5'; params = [status, notes||'', escalationReason||notes||'', deadline.toISOString(), req.params.id]; }
    else if (status === 'complete') { query = 'UPDATE campaign_tasks SET status=$1, agent_notes=$2, updated_at=NOW(), resolved_at=NOW(), last_resolved_date=NOW() WHERE id=$3'; params = [status, notes||'', req.params.id]; }
    else { query = 'UPDATE campaign_tasks SET status=$1, agent_notes=$2, updated_at=NOW() WHERE id=$3'; params = [status, notes||'', req.params.id]; }
    await db.query(query, params);
    try {
      const logAgent = (task.agent_name && ['Aryan','Satyam','Kunal'].includes(task.agent_name)) ? task.agent_name : extractAgentFromCampaign(task.campaign_name||'') || 'Unknown';
      await db.query('INSERT INTO activity_log (campaign_id, campaign_name, agent_name, action, notes, status_before, status_after, task_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [task.campaign_id||'', task.campaign_name||'', logAgent, status, notes||'', statusBefore, status, parseInt(req.params.id)]);
    } catch(logErr) { console.error('Activity log error: ' + logErr.message); }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tasks/:id/archive', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try { await db.query('UPDATE campaign_tasks SET status=$1, archived_at=NOW(), updated_at=NOW() WHERE id=$2', ['archived', req.params.id]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tasks/run-now', async function(req, res) {
  runDailyTaskScheduler().catch(function(e){ console.error('Manual task run error: ' + e.message); });
  res.json({ success: true, message: 'Task scheduler triggered' });
});

app.post('/api/admin/snapshot', async function(req, res) {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const { date, metrics, campaigns } = req.body;
    if (!date || !campaigns) return res.status(400).json({ error: 'date and campaigns required' });
    await db.query('INSERT INTO daily_snapshots (snapshot_date, metrics, campaigns, exhaustion_log, alerts) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (snapshot_date) DO UPDATE SET metrics=$2, campaigns=$3, exhaustion_log=$4, alerts=$5, created_at=NOW()', [date, JSON.stringify(metrics||{}), JSON.stringify(campaigns), JSON.stringify([]), JSON.stringify([])]);
    console.log('Manual snapshot inserted for ' + date + ' (' + campaigns.length + ' campaigns)');
    res.json({ success: true, date: date, campaigns: campaigns.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', function(req, res) { res.json({ status: 'ok', lastSync: state.lastSync, campaigns: state.campaigns.length, error: state.error }); });
app.get('/api/portfolios', function(req, res) { res.json({ portfolios: state.portfolios, count: Object.keys(state.portfolios).length }); });
app.post('/api/sync', function(req, res) { syncCampaigns(); res.json({ success: true }); });

app.post('/api/campaigns/:id/budget', async function(req, res) {
  const id = req.params.id;
  const amount = parseFloat(req.body.amount || 0);
  const campaign = state.campaigns.find(function(c) { return String(c.campaignId) === String(id) || c.campaignId == id; });
  console.log('Budget request for id: ' + id + ', found: ' + (campaign ? campaign.name : 'NOT FOUND') + ', total campaigns: ' + state.campaigns.length);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found: ' + id });
  try {
    const newBudget = campaign.dailyBudget + amount;
    await updateBudget(id, newBudget);
    const log = state.exhaustionLog.find(function(e) { return e.campaign === campaign.name && e.action === 'Pending'; });
    if (log) { log.added = '+£' + amount; log.action = 'Budget added'; log.resolvedAt = new Date().toLocaleTimeString('en-GB', {timeZone:'Europe/London', hour:'2-digit', minute:'2-digit'}); if (log.time) { const outParts = log.time.split(':'); const resParts = log.resolvedAt.split(':'); const gapMins = (parseInt(resParts[0]) * 60 + parseInt(resParts[1])) - (parseInt(outParts[0]) * 60 + parseInt(outParts[1])); log.gap = gapMins > 0 ? gapMins + ' min' : '< 1 min'; } }
    if (db) { try { await db.query('UPDATE campaign_tasks SET status=$1, agent_notes=$2, updated_at=NOW(), resolved_at=NOW() WHERE campaign_id=$3 AND status IN ($4,$5) AND task_source=$6', ['complete', 'Budget +£' + amount + ' added', String(id), 'open', 'in_progress', 'alert']); } catch(e) { console.error('Auto-close task error: ' + e.message); } }
    const approvalAgent = extractAgentFromCampaign(campaign.name) || '';
    const approvalMsg = ['✅ Budget added', campaign.name, '+£' + amount + ' added. New budget: £' + newBudget.toFixed(2)].join('\n');
    if (approvalAgent) await sendToAgent(approvalAgent, approvalMsg);
    if (db) { try { await db.query('INSERT INTO activity_log (campaign_id, campaign_name, agent_name, action, notes) VALUES ($1,$2,$3,$4,$5)', [String(id), campaign.name, approvalAgent || 'Unknown', 'budget_added', '+£' + amount.toFixed(2) + ' added. Was £' + campaign.dailyBudget.toFixed(2) + ' → Now £' + newBudget.toFixed(2)]); } catch(logErr) { console.error('Budget activity log error: ' + logErr.message); } }
    syncCampaigns();
    res.json({ success: true, newBudget: newBudget });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/alerts/:campaignId/dismiss', async function(req, res) {
  const id = req.params.campaignId;
  const reason = req.body.reason || 'No reason given';
  const alert = state.alerts.find(function(a) { return String(a.campaignId) === String(id); });
  state.alerts = state.alerts.filter(function(a) { return String(a.campaignId) !== String(id); });
  if (db && alert) {
    try {
      const agentName = extractAgentFromCampaign(alert.name||'') || 'Unknown';
      await db.query('INSERT INTO activity_log (campaign_id, campaign_name, agent_name, action, notes) VALUES ($1,$2,$3,$4,$5)', [String(id), alert.name || 'Unknown campaign', agentName, 'alert_dismissed', 'Alert dismissed. Reason: ' + reason + '. ACOS at time: ' + (alert.acos||'—') + '%. Alert type: ' + (alert.type||'—')]);
    } catch(logErr) { console.error('Alert dismiss log error: ' + logErr.message); }
  }
  res.json({ success: true });
});

// ── Google Ads Ingest Endpoint ────────────────────────────────────────────
app.post('/api/google/ingest', async function(req, res) {
  const secret = req.headers['x-google-secret'] || req.body.secret;
  const expectedSecret = process.env.GOOGLE_INGEST_SECRET || 'fksports-google-2024';
  if (secret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const campaigns = req.body.campaigns || [];
    const now = new Date();
    const ukHour = parseInt(now.toLocaleString('en-GB', {timeZone:'Europe/London', hour:'2-digit', hour12:false}));
    const alertsSuppressed = ukHour >= 22 || ukHour < 8;
    const dateStr = now.toDateString();
    const timeStr = now.toLocaleTimeString('en-GB', {timeZone:'Europe/London', hour:'2-digit', minute:'2-digit'});
    const ACOS_CRIT = parseFloat(process.env.ACOS_CRITICAL_THRESHOLD || 20);
    const BUDGET_LOW = parseFloat(process.env.BUDGET_LOW_PERCENT || 20);

    const products = req.body.products || [];

    googleState.campaigns = campaigns.map(function(c) {
      const agentName = extractAgentFromCampaign(c.name || "");
      return Object.assign({}, c, { agentName, department: 'google' });
    });
    googleState.products = products.map(function(p) {
      const agentName = extractAgentFromCampaign(p.campaignName || "");
      return Object.assign({}, p, { agentName, department: 'google' });
    });
    googleState.lastSync = timeStr;
    googleState.error = null;
    googleState.lastSnapshot = { campaigns, products, lastSync: timeStr };
    console.log("Google ingest received: " + campaigns.length + " campaigns, " + products.length + " products");

    if (!alertsSuppressed) {
      for (const c of googleState.campaigns) {
        if (c.state !== 'ENABLED' && c.state !== 'enabled') continue;
        const spend = parseFloat(c.spend || 0);
        const sales = parseFloat(c.sales || 0);
        const budget = parseFloat(c.dailyBudget || 0);
        const remaining = parseFloat(c.budgetRemaining || 0);
        const acos = sales > 0 ? Math.round((spend/sales)*100*10)/10 : 0;
        const outOfBudget = remaining <= 0.01 && budget > 0;
        const budgetLow = !outOfBudget && budget > 0 && ((remaining/budget)*100) <= BUDGET_LOW;
        const acosHigh = acos > ACOS_CRIT && spend > 1;
        let alertType = null;
        if (outOfBudget) alertType = 'out_of_budget';
        else if (acosHigh) alertType = 'acos_high';
        else if (budgetLow) alertType = 'budget_low';
        if (!alertType) continue;
        const already = googleState.alerts.find(function(a) { return String(a.campaignId) === String(c.campaignId) && a.date === dateStr && a.type === alertType; });
        if (already) continue;
        googleState.alerts.push({ campaignId: c.campaignId, name: c.name, type: alertType, time: timeStr, date: dateStr, acos: acos, budget: budget, department: 'google' });
        const dashUrl = process.env.DASHBOARD_URL || 'https://app.fksports.co.uk';
        let msg = '';
        if (alertType === 'out_of_budget') msg = '🚨 Out of Budget (Google)\n' + c.name + '\nSpent £' + spend.toFixed(2) + ' of £' + budget.toFixed(2) + '\n' + dashUrl;
        else if (alertType === 'budget_low') msg = '⚡ Budget Low (Google)\n' + c.name + '\n£' + remaining.toFixed(2) + ' remaining\n' + dashUrl;
        else if (alertType === 'acos_high') msg = '📈 High ACoS (Google)\n' + c.name + '\nACoS: ' + acos + '%\n' + dashUrl;
        const agent = c.agentName;
        if (agent) { try { await sendToAgent(agent, msg); } catch(e) { console.error('Google alert send error: ' + e.message); } }
        if (db) { try { await db.query('INSERT INTO activity_log (campaign_id, campaign_name, agent_name, action, notes) VALUES ($1,$2,$3,$4,$5)', [String(c.campaignId), c.name, agent||'Unknown', alertType, msg]); } catch(e) {} }
      }
    }
    res.json({ success: true, campaignsReceived: campaigns.length, productsReceived: products.length });
  } catch(e) {
    console.error('Google ingest error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Google Ads Dashboard Endpoint ─────────────────────────────────────────
app.get('/api/google/dashboard', async function(req, res) {
  const camps = googleState.campaigns || [];
  const alerts = googleState.alerts || [];
  const totalSpend = camps.reduce(function(s,c){ return s+(parseFloat(c.spend)||0); }, 0);
  const totalRevenue = camps.reduce(function(s,c){ return s+(parseFloat(c.sales)||0); }, 0);
  const blendedAcos = totalRevenue > 0 ? Math.round((totalSpend/totalRevenue)*100*10)/10 : 0;
  const outOfBudget = camps.filter(function(c){ return c.budgetRemaining <= 0.01 && c.dailyBudget > 0; }).length;
  const spendNoRevenue = camps.filter(function(c){ return c.spend > 0 && (c.sales === 0 || c.sales === null); }).length;
  res.json({ metrics: { totalSpend: totalSpend.toFixed(2), totalRevenue: totalRevenue.toFixed(2), blendedAcos, outOfBudget, spendNoRevenue, totalCampaigns: camps.length, activeCampaigns: camps.filter(function(c){ return c.state === "ENABLED" || c.state === "enabled"; }).length }, campaigns: camps, products: googleState.products || [], alerts: alerts, lastSync: googleState.lastSync, error: googleState.error });
});

// ── Shopify Integration ───────────────────────────────────────────────────
let shopifyState = {
  products: [],
  lastSync: null,
  error: null
};

async function syncShopifyProducts() {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const store = process.env.SHOPIFY_STORE;
  if (!token || !store) { console.log('Shopify credentials not configured'); return; }

  try {
    console.log('Syncing Shopify products...');

    // Fetch products
    const prodRes = await axios.get('https://' + store + '/admin/api/2021-07/products.json?limit=250&status=active', {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const rawProducts = prodRes.data.products || [];

    // Fetch orders from last 30 days for conversion data (optional - skip if no permission)
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const salesMap = {};
    const unitsMap = {};
    try {
      const orderRes = await axios.get('https://' + store + '/admin/api/2021-07/orders.json?limit=250&status=any&created_at_min=' + since, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      const orders = orderRes.data.orders || [];
      orders.forEach(function(order) {
        (order.line_items || []).forEach(function(item) {
          const pid = String(item.product_id);
          salesMap[pid] = (salesMap[pid] || 0) + parseFloat(item.price) * item.quantity;
          unitsMap[pid] = (unitsMap[pid] || 0) + item.quantity;
        });
      });
      console.log('Shopify orders fetched: ' + orders.length);
    } catch(e) { console.log('Shopify orders skipped (no permission): ' + e.message); }

    shopifyState.products = rawProducts.map(function(p) {
      const pid = String(p.id);
      const totalRevenue = salesMap[pid] || 0;
      const totalUnits = unitsMap[pid] || 0;
      const price = parseFloat((p.variants && p.variants[0] && p.variants[0].price) || 0);
      const inventory = (p.variants || []).reduce(function(s, v) { return s + (v.inventory_quantity || 0); }, 0);
      const imageUrl = p.images && p.images[0] ? p.images[0].src : null;
      const reviewCount = 0; // Shopify basic doesn't expose reviews via API
      const tags = (p.tags || '').split(',').map(function(t){ return t.trim(); });

      return {
        id: pid,
        title: p.title,
        handle: p.handle,
        url: 'https://' + store.replace('.myshopify.com', '') + '.com/products/' + p.handle,
        shopifyUrl: 'https://' + store + '/admin/products/' + pid,
        price: price,
        inventory: inventory,
        imageUrl: imageUrl,
        tags: tags,
        vendor: p.vendor || '',
        productType: p.product_type || '',
        status: p.status,
        revenue30d: Math.round(totalRevenue * 100) / 100,
        unitsSold30d: totalUnits,
        variantCount: (p.variants || []).length,
        createdAt: p.created_at
      };
    });

    shopifyState.lastSync = new Date().toLocaleTimeString('en-GB', {timeZone:'Europe/London', hour:'2-digit', minute:'2-digit'});
    shopifyState.error = null;
    console.log('Shopify sync complete: ' + shopifyState.products.length + ' products');
  } catch(e) {
    console.error('Shopify sync error: ' + e.message);
    shopifyState.error = e.message;
  }
}

// Match a Google Ads row to a Shopify product.
// Priority order:
//   1. Exact match by Shopify item ID (deterministic — preferred for Shopping)
//   2. Match by Shopify product_type (single product in that type only)
//   3. Fuzzy name match (legacy fallback — last resort)
function matchShopifyProduct(googleRow) {
  if (!shopifyState.products.length) return null;
  // Allow legacy callers that still pass a string
  if (typeof googleRow === 'string') {
    googleRow = { name: googleRow };
  }
  if (!googleRow) return null;

  // 1. Match by Shopify item ID — format: "shopify_gb_<productId>_<variantId>"
  if (googleRow.shopifyItemId) {
    const parts = String(googleRow.shopifyItemId).split('_');
    if (parts.length >= 4) {
      const productId = parts[2];
      const found = shopifyState.products.find(function(p) { return String(p.id) === productId; });
      if (found) return found;
    }
  }

  // 2. Match by product_type when exactly one Shopify product has that type
  if (googleRow.productType) {
    const pt = String(googleRow.productType).toLowerCase();
    const candidates = shopifyState.products.filter(function(p) {
      return String(p.productType || '').toLowerCase() === pt;
    });
    if (candidates.length === 1) return candidates[0];
    // If multiple candidates, do not guess — leave unmatched and surface as a bucket
  }

  // 3. Fuzzy name match (legacy) — only use if nothing else worked
  const rawName = googleRow.name || googleRow.productName;
  if (!rawName) return null;
  const name = String(rawName).toLowerCase();
  // Skip useless fuzzy strings (Shopify item IDs as names, ad-group placeholders)
  if (name.indexOf('shopify_gb_') === 0) return null;

  let match = shopifyState.products.find(function(p) { return p.title.toLowerCase() === name; });
  if (match) return match;
  match = shopifyState.products.find(function(p) {
    const title = p.title.toLowerCase();
    return title.includes(name) || name.includes(title);
  });
  if (match) return match;
  const words = name.split(/\s+/).filter(function(w){ return w.length > 3; });
  match = shopifyState.products.find(function(p) {
    const title = p.title.toLowerCase();
    return words.some(function(w){ return title.includes(w); });
  });
  return match || null;
}

// ── Shopify API endpoints ─────────────────────────────────────────────────
app.get('/api/shopify/products', async function(req, res) {
  res.json({ products: shopifyState.products, lastSync: shopifyState.lastSync, error: shopifyState.error });
});

app.post('/api/shopify/sync', async function(req, res) {
  syncShopifyProducts().catch(function(e){ console.error('Manual Shopify sync error: ' + e.message); });
  res.json({ success: true, message: 'Shopify sync triggered' });
});

// ── Google + Shopify Combined Dashboard ───────────────────────────────────
app.get('/api/google/products-diagnostic', async function(req, res) {
  const googleProducts = googleState.products || [];
  const diagnostic = googleProducts.map(function(gp) {
    // v8 sends `name`, `shopifyItemId`, `productType`. Older payloads sent `productName`.
    const rawName = gp.name || gp.productName;
    const shopifyProduct = matchShopifyProduct(gp);

    // Display label — always populate something, never undefined
    const displayName = (shopifyProduct && shopifyProduct.title)
      || rawName
      || gp.productType
      || gp.adGroupName
      || gp.campaignName
      || '(unknown)';

    // Determine diagnosis
    let diagnosis = null;
    let diagnosisType = null;
    let action = null;

    if (gp.impressions === 0) {
      diagnosisType = 'no_impressions';
      diagnosis = 'Ads not showing — check bidding, budget, or targeting';
      action = 'Review bid strategy and daily budget';
    } else if (gp.clicks === 0 && gp.impressions > 50) {
      diagnosisType = 'low_ctr';
      diagnosis = 'Getting impressions but no clicks — ad copy or images are weak';
      action = 'Improve ad headlines and images';
    } else if (gp.clicks > 20 && gp.conversions === 0) {
      diagnosisType = 'no_conversions';
      if (shopifyProduct) {
        if (shopifyProduct.inventory === 0) {
          diagnosisType = 'out_of_stock';
          diagnosis = 'Product is OUT OF STOCK — ads running but nothing to sell';
          action = 'Pause ads immediately and restock';
        } else {
          diagnosisType = 'landing_page';
          diagnosis = 'People clicking but not buying — landing page or price issue';
          action = 'Review product page, pricing, and images';
        }
      } else {
        diagnosis = 'Clicks with zero conversions — check product page quality';
        action = 'Review landing page and checkout flow';
      }
    } else if (gp.conversions > 0 && gp.acos > 0 && gp.acos < 15) {
      diagnosisType = 'scale';
      diagnosis = 'Strong performance — ACOS is healthy, scale this product';
      action = 'Increase daily budget by 50%';
    } else if (gp.acos > 50) {
      diagnosisType = 'high_acos';
      diagnosis = 'Very high ACOS — spending too much to generate sales';
      action = 'Reduce bids or tighten keyword targeting';
    } else if (gp.spend > 0 && gp.sales === 0) {
      diagnosisType = 'spend_no_revenue';
      diagnosis = 'Spending money with zero revenue';
      action = 'Check product page, reviews, and targeting';
    }

    return {
      // Identity
      productId: gp.productId || gp.shopifyItemId || (gp.campaignId + ':' + (rawName || gp.adGroupName || '')),
      productName: displayName,             // legacy field name kept for backwards compat with frontend
      displayName: displayName,
      campaignId: gp.campaignId,
      campaignName: gp.campaignName,
      campaignType: gp.campaignType || null,    // SEARCH | SHOPPING | PERFORMANCE_MAX
      itemType: gp.itemType || null,            // keyword | product_group | pmax_campaign
      adGroupName: gp.adGroupName || null,
      shopifyItemId: gp.shopifyItemId || null,
      productType: gp.productType || null,
      productGroupPath: gp.productGroupPath || null,
      partitionType: gp.partitionType || null,

      // Performance
      spend: gp.spend,
      sales: gp.sales,
      impressions: gp.impressions,
      clicks: gp.clicks,
      conversions: gp.conversions,
      ctr: gp.ctr,
      acos: gp.acos,
      agentName: gp.agentName,

      // Shopify enrichment
      shopifyMatched: !!shopifyProduct,
      shopifyTitle: shopifyProduct ? shopifyProduct.title : null,
      shopifyId: shopifyProduct ? shopifyProduct.id : null,
      shopifyPrice: shopifyProduct ? shopifyProduct.price : null,
      shopifyInventory: shopifyProduct ? shopifyProduct.inventory : null,
      shopifyRevenue30d: shopifyProduct ? shopifyProduct.revenue30d : null,
      shopifyUnitsSold30d: shopifyProduct ? shopifyProduct.unitsSold30d : null,
      shopifyUrl: shopifyProduct ? shopifyProduct.shopifyUrl : null,
      shopifyImageUrl: shopifyProduct ? shopifyProduct.imageUrl : null,

      // Diagnosis
      diagnosisType: diagnosisType,
      diagnosis: diagnosis,
      action: action
    };
  });

  // Sort: problems first, then scale opportunities, then healthy
  const order = { 'out_of_stock': 0, 'no_impressions': 1, 'spend_no_revenue': 2, 'no_conversions': 3, 'landing_page': 3, 'high_acos': 4, 'low_ctr': 5, 'scale': 6 };
  diagnostic.sort(function(a, b) {
    return (order[a.diagnosisType] || 9) - (order[b.diagnosisType] || 9);
  });

  res.json({
    products: diagnostic,
    totalProducts: diagnostic.length,
    shopifyMatched: diagnostic.filter(function(p){ return p.shopifyMatched; }).length,
    lastGoogleSync: googleState.lastSync,
    lastShopifySync: shopifyState.lastSync
  });
});

// ── Cron Jobs ─────────────────────────────────────────────────────────────
cron.schedule('0 8,13,18 * * *', function() {
  console.log('Scheduled keyword report fetch...');
  requestSearchTermReport().catch(function(e){ console.error('Scheduled KW request error: ' + e.message); });
  checkSearchTermReport().catch(function(e){ console.error('Scheduled KW check error: ' + e.message); });
}, { timezone: 'Europe/London' });

cron.schedule('0 8 * * *', function() {
  console.log('Running scheduled daily tasks at 8am UK time');
  runDailyTaskScheduler().catch(function(e){ console.error('Scheduled task error: ' + e.message); });
}, { timezone: 'Europe/London' });

cron.schedule('0 0 * * *', function() {
  autoArchiveTasks().catch(function(e){ console.error('Auto-archive error: ' + e.message); });
}, { timezone: 'Europe/London' });

async function autoArchiveTasks() {
  if (!db) return;
  try {
    const expiredScaling = await db.query("SELECT id, campaign_name, agent_name FROM campaign_tasks WHERE status='scaling' AND scaling_deadline IS NOT NULL AND scaling_deadline < NOW()");
    for (const row of expiredScaling.rows) {
      await db.query("UPDATE campaign_tasks SET status='open', updated_at=NOW() WHERE id=$1", [row.id]);
      await db.query('INSERT INTO activity_log (campaign_id, campaign_name, agent_name, action, notes, status_before, status_after, task_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', ['', row.campaign_name, row.agent_name, 'scaling_expired', '7-day scaling window expired. Task returned to open for immediate action.', 'scaling', 'open', row.id]);
      console.log('Scaling expired for: ' + row.campaign_name);
      if (row.agent_name) {
        const dashUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'https://campaignpulse-setup-production.up.railway.app';
        await sendToAgent(row.agent_name, '🚨 SCALING WINDOW EXPIRED\nCampaign: ' + row.campaign_name + '\n7-day scaling period has ended. Immediate decision required: resolve or pause.\n' + dashUrl + '/tasks');
      }
    }
    const result = await db.query("SELECT id, resolved_at FROM campaign_tasks WHERE status IN ('complete','dismissed','paused') AND archived_at IS NULL AND resolved_at IS NOT NULL");
    let archived = 0;
    const now = new Date();
    for (const row of result.rows) {
      const resolved = new Date(row.resolved_at);
      let workingDays = 0;
      const check = new Date(resolved);
      check.setDate(check.getDate() + 1);
      while (check <= now) { const day = check.getDay(); if (day !== 0 && day !== 6) workingDays++; if (workingDays >= 3) break; check.setDate(check.getDate() + 1); }
      if (workingDays >= 3) { await db.query('UPDATE campaign_tasks SET status=$1, archived_at=NOW() WHERE id=$2', ['archived', row.id]); archived++; }
    }
    if (archived > 0) console.log('Auto-archived ' + archived + ' tasks');
  } catch(e) { console.error('Auto-archive error: ' + e.message); }
}

const interval = process.env.POLL_INTERVAL_MINUTES || 15;
cron.schedule('*/' + interval + ' * * * *', function() { syncCampaigns(); });
cron.schedule('0 */2 * * *', function() { syncShopifyProducts().catch(function(e){ console.error('Shopify cron error: ' + e.message); }); }, { timezone: 'Europe/London' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async function() {
  console.log('App running on port ' + PORT);
  await initDB();
  if (db) {
    try {
      const result = await db.query('SELECT settings FROM app_settings WHERE id = 1');
      const settings = result.rows[0]?.settings || {};
      if (settings.acosCritical) process.env.ACOS_CRITICAL_THRESHOLD = String(settings.acosCritical);
      if (settings.acosWarning) process.env.ACOS_WARNING_THRESHOLD = String(settings.acosWarning);
      if (settings.budgetLowPct) process.env.BUDGET_LOW_PERCENT = String(settings.budgetLowPct);
      if (Object.keys(settings).length) console.log('Settings loaded from DB: ' + JSON.stringify(settings));
    } catch(e) { console.error('Settings load error: ' + e.message); }
  }
  setTimeout(function() {
    syncCampaigns().catch(function(err) { console.error('Initial sync failed:', err.message); });
    syncShopifyProducts().catch(function(err) { console.error('Initial Shopify sync failed:', err.message); });
  }, 30000);
});

// ── Google Product AI Analysis ────────────────────────────────────────────
app.post('/api/google/ai-analyse', async function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'No API key' });
  const { product } = req.body;
  if (!product) return res.status(400).json({ error: 'No product data' });
  try {
    const prompt = `You are a Google Ads and e-commerce expert for FK Sports UK (fitness equipment).

PRODUCT: ${product.productName}
CAMPAIGN: ${product.campaignName}

TODAY'S GOOGLE ADS PERFORMANCE:
- Impressions: ${product.impressions}
- Clicks: ${product.clicks}
- CTR: ${product.ctr}%
- Conversions: ${product.conversions}
- Ad Spend: £${product.spend}
- Revenue: £${product.sales}
- ACoS: ${product.acos}%

SHOPIFY DATA:
${product.shopifyMatched ? `- Product: ${product.shopifyTitle}
- Price: £${product.shopifyPrice}
- Inventory: ${product.shopifyInventory === 0 ? 'OUT OF STOCK' : product.shopifyInventory + ' units'}
- Revenue last 30 days: £${product.shopifyRevenue30d}
- Units sold last 30 days: ${product.shopifyUnitsSold30d}` : '- No Shopify match found for this product'}

CURRENT DIAGNOSIS: ${product.diagnosis || 'None'}

Provide a concise analysis (3-4 sentences max):
1. What is the root cause of this product's performance issue?
2. One specific action to take RIGHT NOW
3. What result to expect if the action is taken

Be direct, specific, actionable. No generic advice.`;

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-opus-4-5-20251101',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    });

    res.json({ analysis: response.data.content[0].text });
  } catch(e) {
    console.error('Google AI analyse error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});
