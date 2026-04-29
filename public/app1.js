
window.appData = { metrics:{}, campaigns:[], alerts:[], exhaustionLog:[], lastSync:null };

// Global agent name extractor - works on both campaign names and stored agent names
function getTaskAgent(t) {
  const src = t.campaign_name || t.agent_name || '';
  const parts = src.split(/[|@]/);
  const name = parts[0].trim();
  return (name.length > 0 && name.length < 30) ? name : (t.agent_name || 'Unassigned');
}
function getTaskAgentName(t) { return getTaskAgent(t); }
window.allCampaigns = [];
window.currentFilter = 'action';
window.sortState = { col: null, dir: 1 };
window.reportSortState = { col: 'date', dir: -1 };

function sortReport(col) {
  if (reportSortState.col === col) { reportSortState.dir *= -1; }
  else { reportSortState.col = col; reportSortState.dir = -1; }
  document.querySelectorAll('[id^="rs-"]').forEach(function(el){ el.textContent = ''; });
  const ind = document.getElementById('rs-' + col);
  if (ind) ind.textContent = reportSortState.dir === -1 ? ' ↓' : ' ↑';
  renderReport();
}
const pageTitles = { dashboard:'Dashboard', campaigns:'All campaigns', ai:'AI analysis', keywords:'Keyword Intelligence', report:'Budget exhaustion report', activity:'Activity log', settings:'Settings' };

// ── Navigation ─────────────────────────────────────────────────────────────
function showPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  if (btn) btn.classList.add('active');
  document.getElementById('page-title').textContent = pageTitles[name] || name;
  if (name === 'campaigns') renderAllCampaigns();
  if (name === 'report') renderReport();
  if (name === 'history') loadHistoryDates();
  if (name === 'stuck') loadStuckCampaigns();
  if (name === 'tasks') loadTasks();
  if (name === 'settings') loadSettings();
  if (name === 'activity') renderActivity();
  if (name === 'ai') runAI();
  if (name === 'keywords') loadKeywords();
}

// ── Fetch data ─────────────────────────────────────────────────────────────
async function fetchData() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch('/api/dashboard', { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('API error ' + res.status);
    appData = await res.json();
    allCampaigns = appData.campaigns || [];
    renderDashboard();
    updateSyncTime();
    populateFilters();
  } catch(e) {
    console.error('Fetch error:', e.message);
    document.getElementById('sync-time').textContent = 'Connection error - retrying...';
    setTimeout(fetchData, 5000);
  }
}

function updateSyncTime() {
  document.getElementById('sync-time').textContent = appData.lastSync ? 'Synced ' + appData.lastSync : 'Synced just now';
  document.getElementById('sync-dot').classList.remove('syncing');
}

async function refreshData() {
  document.getElementById('sync-dot').classList.add('syncing');
  document.getElementById('sync-time').textContent = 'Syncing...';
  await fetch('/api/sync', { method: 'POST' });
  setTimeout(fetchData, 4000);
}

function populateFilters() {
  const names = [...new Set(allCampaigns.map(c => c.name))].sort();
  ['rf-campaign', 'activity-filter'].forEach(function(id) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">All campaigns</option>' + names.map(n => '<option value="'+escHtml(n)+'"'+(n===cur?' selected':'')+'>'+escHtml(n)+'</option>').join('');
  });
}

// ── Dashboard ──────────────────────────────────────────────────────────────
let dashTab = 'all';
function setDashTab(tab, btn) {
  dashTab = tab;
  document.querySelectorAll('#page-dashboard .tabs .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderDashboardTable();
}

function renderDashboardTable() {
  const camps = allCampaigns;
  const spendNoRev = camps.filter(c => c.spend > 0 && (c.sales === 0 || c.sales === null));
  const noActivity = camps.filter(c => (c.spend === 0 || c.spend === null) && (c.impressions === 0));
  document.getElementById('cnt-spend-no-rev').textContent = spendNoRev.length;
  document.getElementById('cnt-no-activity').textContent = noActivity.length;

  // Show/hide wasted spend banner
  const wastedBanner = document.getElementById('wasted-spend-banner');
  if (dashTab === 'spend_no_revenue' && spendNoRev.length > 0) {
    const totalWasted = spendNoRev.reduce(function(s,c){ return s+(c.spend||0); }, 0);
    wastedBanner.style.display = '';
    document.getElementById('wasted-total').textContent = '£' + totalWasted.toFixed(2);
    document.getElementById('wasted-count').textContent = spendNoRev.length;
  } else {
    wastedBanner.style.display = 'none';
  }

  // Show/hide no activity info
  const noActBanner = document.getElementById('no-activity-banner');
  if (dashTab === 'no_activity' && noActivity.length > 0) {
    noActBanner.style.display = '';
    document.getElementById('no-activity-count').textContent = noActivity.length;
  } else {
    noActBanner.style.display = 'none';
  }

  let toShow;
  if (dashTab === 'spend_no_revenue') toShow = spendNoRev.sort(function(a,b){ return (b.spend||0)-(a.spend||0); });
  else if (dashTab === 'no_activity') toShow = noActivity;
  else {
    const needsAction = camps.filter(c => c.budgetRemaining <= 0.01 || c.acos > 35 || c.budgetPct >= 80);
    const healthy = camps.filter(c => c.budgetRemaining > 0.01 && c.acos <= 35 && c.budgetPct < 80).slice(0,3);
    toShow = [...needsAction, ...healthy].slice(0, 12);
  }
  renderCampaignTable('dash-table', toShow, true);
}

function renderDashboard() {
  const m = appData.metrics || {};
  document.getElementById('m-revenue').textContent = '£' + parseFloat(m.totalRevenue || 0).toFixed(2);
  document.getElementById('m-spend').textContent = '£' + parseFloat(m.totalSpend || 0).toFixed(2);
  document.getElementById('m-acos').textContent = (m.blendedAcos || 0) + '%';
  document.getElementById('m-action').textContent = m.needsAction || 0;
  const acosTarget = 12;
  document.getElementById('m-acos-d').textContent = m.blendedAcos > acosTarget ? '▲ Above ' + acosTarget + '% target' : '▼ Within ' + acosTarget + '% target';
  document.getElementById('m-acos-d').className = 'metric-delta ' + (m.blendedAcos > acosTarget ? 'delta-down' : 'delta-up');
  document.getElementById('m-action-d').textContent = (m.needsAction || 0) + ' campaigns need attention';
  const nb = document.getElementById('nb-action');
  if (m.needsAction > 0) { nb.textContent = m.needsAction; nb.style.display = ''; }
  else nb.style.display = 'none';
  const active = allCampaigns.filter(c => c.state === 'enabled').length;
  const outOfBudget = allCampaigns.filter(c => c.budgetRemaining <= 0.01 && c.dailyBudget > 0).length;
  document.getElementById('camp-sub').textContent = active + ' active · ' + outOfBudget + ' out of budget · showing campaigns needing action first';
  renderAlerts();
  renderDashboardTable();
}

function renderAlerts() {
  const container = document.getElementById('alert-container');
  const alerts = (appData.alerts || []).filter(a => a.type === 'out_of_budget');
  if (!alerts.length) { container.innerHTML = ''; return; }
  container.innerHTML = alerts.map(a => `
    <div class="alert-banner" id="alert-${a.campaignId}">
      <span style="font-size:16px">⚠</span>
      <div class="alert-banner-text"><strong>${escHtml(a.name)}</strong> ran out of budget at ${a.time}. ACOS: ${a.acos}%.</div>
      <button class="btn btn-green" onclick="approveBudget('${a.campaignId}','')">Add budget</button>
      <button class="btn btn-ghost" onclick="dismissAlert('${a.campaignId}')">Dismiss</button>
    </div>
  `).join('');
}

// ── Dismiss alert with reason ─────────────────────────────────────────────
function dismissAlert(campaignId) {
  const reasons = ['High ACOS', 'No CVR', 'Test Low Budget', 'Other'];
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:9998;display:flex;align-items:center;justify-content:center';
  const popup = document.createElement('div');
  popup.style.cssText = 'background:white;padding:24px;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.2);min-width:320px;max-width:400px;width:90%';
  const optHtml = reasons.map(function(r){ return '<option>' + r + '</option>'; }).join('');
  popup.innerHTML = '<div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px">Dismiss reason</div>' +
    '<div style="font-size:12px;color:var(--text3);margin-bottom:14px">Why are you not adding budget?</div>' +
    '<select id="da-reason" style="width:100%;padding:9px;border:1px solid var(--border2);border-radius:7px;margin-bottom:10px;font-size:13px;font-family:inherit">' + optHtml + '</select>' +
    '<textarea id="da-other" placeholder="Describe reason..." style="width:100%;padding:9px;border:1px solid var(--border2);border-radius:7px;font-size:13px;height:64px;display:none;margin-bottom:10px;resize:none;font-family:inherit"></textarea>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end">' +
    '<button id="da-cancel" class="btn btn-ghost" style="font-size:13px">Cancel</button>' +
    '<button id="da-confirm" class="btn btn-primary" style="font-size:13px">Confirm dismiss</button></div>';
  popup.querySelector('#da-reason').onchange = function() {
    popup.querySelector('#da-other').style.display = this.value === 'Other' ? '' : 'none';
  };
  popup.querySelector('#da-cancel').onclick = function() { overlay.remove(); };
  popup.querySelector('#da-confirm').onclick = async function() {
    const reason = popup.querySelector('#da-reason').value === 'Other'
      ? (popup.querySelector('#da-other').value || 'Other')
      : popup.querySelector('#da-reason').value;
    overlay.remove();
    // Find and dismiss the alert task in DB
    try {
      const tasksRes = await fetch('/api/tasks');
      const tasksData = await tasksRes.json();
      const alertTask = (tasksData.tasks||[]).find(function(t){ return String(t.campaign_id)===String(campaignId) && t.task_source==='alert' && (t.status==='open'||t.status==='in_progress'); });
      if (alertTask) {
        await fetch('/api/tasks/' + alertTask.id + '/status', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ status: 'dismissed', dismissedReason: reason, notes: reason })
        });
      }
    } catch(e) {}
    // Remove banner
    const banner = document.getElementById('alert-' + campaignId);
    if (banner) banner.remove();
  };
  overlay.appendChild(popup);
  overlay.onclick = function(e){ if(e.target===overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

// ── Campaign table ─────────────────────────────────────────────────────────
function renderCampaignTable(tableId, campaigns, showAction) {
  const tbody = document.getElementById(tableId);
  if (!campaigns.length) { tbody.innerHTML = '<tr><td colspan="14"><div class="empty">No campaigns found</div></td></tr>'; return; }
  tbody.innerHTML = campaigns.map(c => {
    const outOfBudget = c.budgetRemaining <= 0.01 && c.dailyBudget > 0;
    const budgetLow = c.budgetPct >= 80 && !outOfBudget;
    const acosHigh = c.acos > 35 && c.spend > 5;
    const isAuto = c.targetingType === 'auto';
    const budgetColor = outOfBudget ? 'color:var(--red);font-weight:600' : budgetLow ? 'color:var(--amber);font-weight:500' : '';
    const acosClass = c.acos > 35 ? 'acos-high' : c.acos > 25 ? 'acos-warn' : c.acos > 0 ? 'acos-ok' : '';
    const progColor = outOfBudget ? 'var(--red)' : budgetLow ? 'var(--amber)' : 'var(--green)';
    const noData = c.spend === null;
    let statusBadge = '<span class="badge badge-green"><span class="dot" style="background:var(--green)"></span>Healthy</span>';
    if (outOfBudget) statusBadge = '<span class="badge badge-red"><span class="dot" style="background:var(--red)"></span>Out of budget</span>';
    else if (acosHigh) statusBadge = '<span class="badge badge-red"><span class="dot" style="background:var(--red)"></span>ACOS high</span>';
    else if (budgetLow) statusBadge = '<span class="badge badge-amber"><span class="dot" style="background:var(--amber)"></span>Budget low</span>';
    let action = '<button class="btn btn-ghost" style="font-size:12px">View</button>';
    if (showAction) {
      if (outOfBudget) action = '<div class="ag"><button class="btn btn-green" onclick="approveBudget(\''+c.campaignId+'\',\'\')">Add budget</button><button class="btn btn-ghost" style="font-size:12px">Skip</button></div>';
      else if (acosHigh) action = '<div class="ag"><button class="btn btn-amber" style="font-size:12px">Fix bids</button></div>';
      else if (budgetLow) action = '<div class="ag"><button class="btn btn-green" onclick="approveBudget(\''+c.campaignId+'\',\'\')">Add budget</button></div>';
      else action = '<button class="btn btn-ghost" style="font-size:12px">Scale ↗</button>';
    }
    const typeBadge = isAuto ? '<span class="badge badge-blue" style="font-size:10px">Auto</span>' : '<span class="badge" style="background:var(--surface3);color:var(--text3);font-size:10px">Manual</span>';
    return `<tr>
      <td><div class="camp-name">${escHtml(c.name)}</div><div class="camp-meta">${c.campaignId}</div></td>
      <td><div class="camp-name">${escHtml(c.portfolio||'—')}</div><div class="camp-meta">${escHtml(c.agent||'')}</div></td>
      ${tableId === 'all-table' ? '<td>' + typeBadge + '</td>' : ''}
      ${tableId === 'all-table' ? '<td class="mono">£' + c.dailyBudget + '</td>' : ''}
      <td><div class="mono" style="${budgetColor}">£${c.budgetRemaining} / £${c.dailyBudget}</div><div class="prog"><div class="prog-fill" style="width:${Math.min(c.budgetPct,100)}%;background:${progColor}"></div></div></td>
      <td class="mono">${noData ? '<span style="color:var(--text3)">—</span>' : (c.impressions||0).toLocaleString()}</td>
      <td class="mono">${noData ? '<span style="color:var(--text3)">—</span>' : (c.clicks||0).toLocaleString()}</td>
      <td class="mono">${noData ? '<span style="color:var(--text3)">—</span>' : (c.ctr||'0.00') + '%'}</td>
      <td class="mono">${noData ? '<span style="color:var(--text3)">—</span>' : (c.conversions||0)}</td>
      <td class="mono">${c.sales !== null ? '£' + c.sales : '<span style="color:var(--text3);font-size:11px">loading</span>'}</td>
      <td class="mono">${c.spend !== null ? '£' + c.spend : '<span style="color:var(--text3);font-size:11px">loading</span>'}</td>
      <td class="mono ${acosClass}">${c.acos > 0 ? c.acos + '%' : '—'}</td>
      <td>${statusBadge}</td>
      <td>${action}</td>
    </tr>`;
  }).join('');
}

// ── All Campaigns ──────────────────────────────────────────────────────────
function renderAllCampaigns() {
  const search = (document.getElementById('camp-search')?.value || '').toLowerCase();
  const portfolioFilter = document.getElementById('camp-portfolio-filter')?.value || '';
  const typeFilter = document.getElementById('camp-type-filter')?.value || '';
  let filtered = getFilteredCampaigns(currentFilter);
  if (search) filtered = filtered.filter(c => c.name.toLowerCase().includes(search) || (c.portfolio||'').toLowerCase().includes(search));
  if (portfolioFilter) {
    filtered = filtered.filter(function(c){
      const parts = (c.name||'').split(/[|@]/);
      const agentName = parts[0].trim();
      return agentName === portfolioFilter;
    });
  }
  if (typeFilter) filtered = filtered.filter(c => (c.targetingType||'') === typeFilter);
  // Sort
  if (sortState.col) {
    filtered.sort(function(a,b) {
      let va = a[sortState.col], vb = b[sortState.col];
      if (va === null || va === undefined) va = -1;
      if (vb === null || vb === undefined) vb = -1;
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      return va < vb ? -sortState.dir : va > vb ? sortState.dir : 0;
    });
  } else {
    // Default: sort problems first
    filtered.sort(function(a,b) {
      const scoreA = (a.budgetRemaining<=0.01&&a.dailyBudget>0)?3:(a.budgetPct>=80?2:(a.acos>35&&a.spend>5?1:0));
      const scoreB = (b.budgetRemaining<=0.01&&b.dailyBudget>0)?3:(b.budgetPct>=80?2:(b.acos>35&&b.spend>5?1:0));
      return scoreB - scoreA;
    });
  }
  document.getElementById('t-all').textContent = allCampaigns.length;
  document.getElementById('t-action').textContent = allCampaigns.filter(c => c.budgetRemaining <= 0.01 || c.acos > 35 || c.budgetPct >= 80).length;
  document.getElementById('t-healthy').textContent = allCampaigns.filter(c => c.budgetRemaining > 0.01 && c.acos <= 35 && c.budgetPct < 80).length;
  renderCampaignTable('all-table', filtered, true);
  // Populate portfolio filter
  const sel = document.getElementById('camp-portfolio-filter');
  if (sel && sel.options.length <= 1) {
    const agents = [...new Set(allCampaigns.map(function(c){
      const parts = (c.name||'').split(/[|@]/);
      const name = parts[0].trim();
      return name.length > 0 && name.length < 30 ? name : '';
    }).filter(Boolean))].sort();
    agents.forEach(function(a) { const o = document.createElement('option'); o.value=a; o.textContent=a; sel.appendChild(o); });
  }
}

function getFilteredCampaigns(type) {
  if (type === 'action') return allCampaigns.filter(c => c.budgetRemaining <= 0.01 || c.acos > 35 || c.budgetPct >= 80);
  if (type === 'healthy') return allCampaigns.filter(c => c.budgetRemaining > 0.01 && c.acos <= 35 && c.budgetPct < 80);
  return [...allCampaigns];
}

function filterCamps(type, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentFilter = type;
  renderAllCampaigns();
}

function sortCamps(col) {
  if (sortState.col === col) { sortState.dir *= -1; }
  else { sortState.col = col; sortState.dir = -1; }
  // Update sort indicators
  document.querySelectorAll('[id^="sort-"]').forEach(el => el.textContent = '');
  const indicator = document.getElementById('sort-' + col);
  if (indicator) indicator.textContent = sortState.dir === -1 ? ' ↓' : ' ↑';
  renderAllCampaigns();
}

// ── Budget approval ────────────────────────────────────────────────────────
async function approveBudget(campaignId, suggested) {
  const camp = allCampaigns.find(c => String(c.campaignId) === String(campaignId));
  const name = camp ? camp.name : campaignId;
  const current = camp ? camp.dailyBudget : 0;
  const input = prompt('Campaign: ' + name + '\nCurrent daily budget: £' + current + '\n\nHow much would you like to add? (£)', suggested || '');
  if (input === null) return;
  const amount = parseFloat(input);
  if (isNaN(amount) || amount <= 0) { alert('Please enter a valid amount'); return; }
  try {
    const res = await fetch('/api/campaigns/' + campaignId + '/budget', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount })
    });
    const data = await res.json();
    if (data.success) { alert('Done! +£' + amount + ' added. New budget: £' + data.newBudget.toFixed(2)); setTimeout(fetchData, 2000); }
    else alert('Error: ' + (data.error || 'Unknown'));
  } catch(e) { alert('Error: ' + e.message); }
}

// ── Report ─────────────────────────────────────────────────────────────────
function renderReport() {
  const log = appData.exhaustionLog || [];
  const campFilter = document.getElementById('rf-campaign')?.value || '';
  const typeFilter = document.getElementById('rf-type')?.value || 'all';
  let filtered = log;
  if (campFilter) filtered = filtered.filter(e => e.campaign === campFilter);
  if (typeFilter !== 'all') filtered = filtered.filter(e => e.type === typeFilter);
  // Sort
  filtered.sort(function(a,b) {
    const col = reportSortState.col;
    let va = col === 'missed' ? parseFloat((a.missed||'0').replace(/[^0-9.]/g,'')) :
             col === 'budget' ? parseFloat((a.budget||'0').replace(/[^0-9.]/g,'')) :
             col === 'gap' ? parseInt(a.gap||0) :
             col === 'acos' ? parseFloat(a.acos||0) :
             (a[col]||'');
    let vb = col === 'missed' ? parseFloat((b.missed||'0').replace(/[^0-9.]/g,'')) :
             col === 'budget' ? parseFloat((b.budget||'0').replace(/[^0-9.]/g,'')) :
             col === 'gap' ? parseInt(b.gap||0) :
             col === 'acos' ? parseFloat(b.acos||0) :
             (b[col]||'');
    return va < vb ? reportSortState.dir : va > vb ? -reportSortState.dir : 0;
  });
  document.getElementById('rpt-events').textContent = filtered.length;
  document.getElementById('rpt-events-d').textContent = filtered.length + ' events recorded';
  const missed = filtered.reduce((s,e) => s + parseFloat((e.missed||'0').replace(/[^0-9.]/g,'')), 0);
  document.getElementById('rpt-missed').textContent = '£' + missed.toFixed(0);
  const resolved = filtered.filter(e => e.gap);
  const avgGap = resolved.length ? Math.round(resolved.reduce((s,e) => s + parseInt(e.gap), 0) / resolved.length) : null;
  document.getElementById('rpt-avg-gap').textContent = avgGap ? avgGap + ' min' : '—';
  if (filtered.length >= 3) {
    const counts = {};
    filtered.forEach(e => { counts[e.campaign] = (counts[e.campaign]||0)+1; });
    const top = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
    if (top && top[1] >= 2) {
      document.getElementById('rpt-insight').style.display = '';
      document.getElementById('rpt-insight-text').textContent = top[0] + ' has run out of budget ' + top[1] + ' times. Consider permanently increasing its daily budget.';
    }
  }
  const tbody = document.getElementById('report-table');
  if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="12"><div class="empty">No events recorded yet.</div></td></tr>'; return; }
  tbody.innerHTML = filtered.map(e => `
    <tr>
      <td class="mono" style="color:var(--text3);white-space:nowrap">${e.date||'—'}</td>
      <td><div class="camp-name">${escHtml(e.campaign||'—')}</div></td>
      <td style="font-size:12px">${escHtml(e.portfolio||'—')}</td>
      <td style="font-size:12px">${escHtml(e.agent||'—')}</td>
      <td class="mono">${e.budget||'—'}</td>
      <td class="mono" style="color:var(--red);font-weight:600">${e.time||'—'}</td>
      <td class="mono ${parseFloat(e.acos)>35?'acos-high':parseFloat(e.acos)>25?'acos-warn':'acos-ok'}">${e.acos||'—'}</td>
      <td class="mono" style="color:var(--red)">${e.missed||'—'}</td>
      <td class="mono" style="color:var(--green)">${e.resolvedAt||'—'}</td>
      <td class="mono" style="color:${e.gap?'var(--amber)':'var(--text3)'};font-weight:${e.gap?'600':'400'}">${e.gap||'—'}</td>
      <td class="mono" style="color:${e.added&&e.added!=='Pending'?'var(--green)':'var(--amber)'}">${e.added||'—'}</td>
      <td><span class="badge ${e.action==='Budget added'?'badge-green':e.action==='Dismissed'?'badge-red':'badge-amber'}">${e.action||'—'}</span></td>
    </tr>`).join('');
}

// ── Activity log ───────────────────────────────────────────────────────────
function renderActivity() {
  const campFilter = document.getElementById('activity-filter')?.value || '';
  const typeFilter = document.getElementById('activity-type')?.value || '';
  let alerts = [...(appData.alerts||[])].reverse();
  if (campFilter) alerts = alerts.filter(a => a.name === campFilter);
  if (typeFilter) alerts = alerts.filter(a => a.type === typeFilter);
  const container = document.getElementById('activity-log');
  if (!alerts.length) { container.innerHTML = '<div class="empty" style="padding:40px">No activity recorded yet.</div>'; return; }
  const typeLabels = { out_of_budget: 'Out of budget', acos_high: 'High ACOS', budget_low: 'Budget low' };
  const typeIcons = { out_of_budget: '⚠', acos_high: '📈', budget_low: '⚡' };
  const typeColors = { out_of_budget: 'var(--red-bg)', acos_high: 'var(--amber-bg)', budget_low: 'var(--amber-bg)' };
  container.innerHTML = alerts.slice(0,50).map(a => `
    <div style="display:flex;gap:14px;padding:14px 0;border-bottom:1px solid var(--border)">
      <div style="font-family:var(--mono);font-size:11px;color:var(--text3);width:55px;flex-shrink:0;padding-top:4px">${a.time||'—'}</div>
      <div style="width:28px;height:28px;border-radius:8px;background:${typeColors[a.type]||'var(--surface3)'};display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0">${typeIcons[a.type]||'•'}</div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600;color:var(--text)">${typeLabels[a.type]||a.type} — ${escHtml(a.name)}</div>
        <div style="font-size:12px;color:var(--text3);margin-top:3px">Portfolio: ${escHtml(a.portfolio||'N/A')} · Agent: ${escHtml(a.agent||'N/A')} · ACOS: ${a.acos}% · Budget: £${a.budget}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:3px">${a.date}</div>
      </div>
      <div>${a.type==='out_of_budget'?'<button class="btn btn-green" style="font-size:12px" onclick="approveBudget(\''+a.campaignId+'\',\'\')">Add budget</button>':''}</div>
    </div>`).join('');
}

// ── AI Analysis ────────────────────────────────────────────────────────────
let aiCache = { suggestions: null, lastRun: 0 };

async function runAI() {
  const container = document.getElementById('ai-container');
  if (!allCampaigns.length) { container.innerHTML = '<div class="empty">No campaign data available.</div>'; return; }

  // Use cache if less than 30 minutes old
  if (aiCache.result && (Date.now() - aiCache.lastRun) < 30 * 60 * 1000) {
    renderAIResult(container, aiCache.result);
    return;
  }

  container.innerHTML = '<div class="loading"><div class="spinner"></div> Analysing FK Sports campaign history with Claude AI...<br><span style="font-size:11px;color:var(--text3);margin-top:8px;display:block">Reviewing 7 days of data · Results cached for 30 minutes</span></div>';
  try {
    const res = await fetch('/api/ai/analyse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const data = await res.json();
    if (!data.result) throw new Error(data.error || 'No result');
    aiCache = { result: data.result, lastRun: Date.now() };
    renderAIResult(container, data.result);
  } catch(e) {
    container.innerHTML = '<div class="empty">AI analysis unavailable: ' + e.message + '</div>';
  }
}

function renderAIResult(container, result) {
  const lastRun = aiCache.lastRun ? new Date(aiCache.lastRun).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'}) : '';
  const daysLabel = result.daysOfData > 0 ? 'Based on ' + result.daysOfData + ' days of historical data' : "Based on today data";

  // Update metrics
  document.getElementById('ai-opps').textContent = result.scaleList?.length || 0;
  document.getElementById('ai-waste').textContent = result.reduceList?.length || 0;
  document.getElementById('ai-gain').textContent = result.pauseList?.length || 0;

  const refreshBtn = '<div style="font-size:11px;color:var(--text3);margin-bottom:16px">' + daysLabel + ' · Last run: ' + lastRun + ' · <button onclick="aiCache.lastRun=0;runAI()" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:11px;font-family:inherit">Refresh</button></div>';

  const strategicBox = result.strategicInsight ? '<div class="insight-box" style="margin-bottom:20px"><div class="insight-title">✦ Strategic insight from Claude AI</div><div class="insight-text">' + escHtml(result.strategicInsight) + '</div></div>' : '';

  const renderTable = function(list, cols, emptyMsg) {
    if (!list || !list.length) return '<div class="empty" style="padding:20px">' + emptyMsg + '</div>';
    return '<div class="table-card"><div style="overflow-x:auto"><table><thead><tr>' + cols.map(function(c){ return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>' +
      list.map(function(c) {
        return '<tr><td><div class="camp-name">' + escHtml(c.name) + '</div></td>' +
          '<td style="font-size:12px;color:var(--text2)">' + escHtml(c.portfolio||'—') + '</td>' +
          '<td class="mono ' + (parseFloat(c.acos)>35?'acos-high':parseFloat(c.acos)>12?'acos-warn':parseFloat(c.acos)>0?'acos-ok':'') + '">' + escHtml(c.acos||'—') + '</td>' +
          '<td class="mono" style="color:var(--red)">£' + escHtml(c.spend||'0') + '</td>' +
          '<td style="font-size:12px;color:var(--text3)">' + escHtml(c.reason) + '</td>' +
          '<td style="font-size:12px;font-weight:500">' + escHtml(c.action) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div></div>';
  };

  container.innerHTML = refreshBtn + strategicBox +
    '<div class="tabs" id="ai-tabs" style="margin-bottom:16px">' +
      '<button class="tab-btn active" onclick="showAITab(\"scale\",this)">📈 Scale (' + (result.scaleList?.length||0) + ')</button>' +
      '<button class="tab-btn" onclick="showAITab(\"pause\",this)">⏸ Pause (' + (result.pauseList?.length||0) + ')</button>' +
      '<button class="tab-btn" onclick="showAITab(\"reduce\",this)">✂️ Reduce budget (' + (result.reduceList?.length||0) + ')</button>' +
    '</div>' +
    '<div id="ai-tab-scale">' + renderTable(result.scaleList, ['Campaign','Portfolio','ACOS','7d Spend','Why scale','Recommended action'], 'No scale opportunities identified') + '</div>' +
    '<div id="ai-tab-pause" style="display:none">' + renderTable(result.pauseList, ['Campaign','Portfolio','ACOS','Spend','Why pause','Recommended action'], 'No campaigns recommended for pausing') + '</div>' +
    '<div id="ai-tab-reduce" style="display:none">' + renderTable(result.reduceList, ['Campaign','Portfolio','ACOS','Spend','Why reduce','Recommended action'], 'No campaigns recommended for budget reduction') + '</div>';
}

function showAITab(tab, btn) {
  ['scale','pause','reduce'].forEach(function(t) {
    const el = document.getElementById('ai-tab-' + t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  document.querySelectorAll('#ai-tabs .tab-btn').forEach(function(b){ b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
}

function renderFallbackAI(container, lowAcos, highAcos, outOfBudget) {
  const cards = [];
  if (outOfBudget.length > 0) {
    const c = outOfBudget[0];
    cards.push(`<div class="ai-card"><div class="ai-header"><div class="ai-icon">💰</div><div><div class="ai-title">Budget increase — ${escHtml(c.name)}</div><div class="ai-sub">Out of budget today · ACOS: ${c.acos}%</div></div><span class="badge badge-amber" style="margin-left:auto">Revenue at risk</span></div><div class="ai-desc">${escHtml(c.name)} has run out of budget. With its current ACOS of ${c.acos}%, this is a profitable campaign. Increasing the daily budget will allow it to continue generating revenue for the rest of the day.</div><div class="ai-impact">✓ Recommended: Increase daily budget by £${Math.ceil(c.dailyBudget*0.5)} to £${(c.dailyBudget*1.5).toFixed(0)}</div><div class="ag"><button class="btn btn-green" onclick="approveBudget('${c.campaignId}','')" style="font-size:12px">Add budget</button><button class="btn btn-ghost" style="font-size:12px">Dismiss</button></div></div>`);
  }
  if (lowAcos.length > 0) {
    const c = lowAcos[0];
    cards.push(`<div class="ai-card"><div class="ai-header"><div class="ai-icon">📈</div><div><div class="ai-title">Scale opportunity — ${escHtml(c.name)}</div><div class="ai-sub">ACOS: ${c.acos}% — well below 15% threshold</div></div><span class="badge badge-green" style="margin-left:auto">+£80-120/day</span></div><div class="ai-desc">${escHtml(c.name)} is performing excellently. This campaign has strong conversion rates and is leaving revenue on the table. Increasing the budget would proportionally increase sales at the same profitable ACOS.</div><div class="ai-impact">✓ Recommended: Increase daily budget from £${c.dailyBudget} to £${(c.dailyBudget*1.5).toFixed(0)}</div><div class="ag"><button class="btn btn-green" onclick="approveBudget('${c.campaignId}','')" style="font-size:12px">Add budget</button><button class="btn btn-ghost" style="font-size:12px">Dismiss</button></div></div>`);
  }
  if (highAcos.length > 0) {
    const c = highAcos[0];
    cards.push(`<div class="ai-card"><div class="ai-header"><div class="ai-icon">✂️</div><div><div class="ai-title">Reduce waste — ${escHtml(c.name)}</div><div class="ai-sub">ACOS: ${c.acos}% — above 35% threshold</div></div><span class="badge badge-red" style="margin-left:auto">£${c.spend} wasted</span></div><div class="ai-desc">${escHtml(c.name)} has an ACOS of ${c.acos}% which is above your target. Review the keywords in this campaign and add negative keywords for search terms that are spending budget without converting. Check Keyword Intelligence for specific recommendations.</div><div class="ai-impact">✓ Recommended: Review keywords and add negatives for zero-conversion search terms</div><div class="ag"><button class="btn btn-amber" style="font-size:12px">Review keywords</button><button class="btn btn-ghost" style="font-size:12px">Dismiss</button></div></div>`);
  }
  container.innerHTML = cards.length ? cards.join('') : '<div class="empty">All campaigns look healthy. No immediate actions needed.</div>';
}

// ── Keyword Intelligence ────────────────────────────────────────────────────
async function loadKeywords() {
  const container = document.getElementById('kw-container');
  try {
    const statusRes = await fetch('/api/keywords/status');
    const status = await statusRes.json();
    if (status.reportId) {
      document.getElementById('kw-status').textContent = 'Report generating... refresh in a few minutes';
      container.innerHTML = '<div class="loading"><div class="spinner"></div> Search term report is being generated. This takes a few minutes.</div>';
      return;
    }
    if (!status.hasData) {
      document.getElementById('kw-status').textContent = 'No data yet — click "Request fresh analysis" to start';
      container.innerHTML = '<div class="empty" style="padding:60px"><div style="font-size:32px;margin-bottom:16px">🔍</div><div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:8px">No keyword data yet</div><div style="font-size:13px;color:var(--text3);margin-bottom:20px">Click "Request fresh analysis" to pull your last 7 days of search term data.<br>The report takes 2-5 minutes to generate then runs automatically every week.</div><button class="btn btn-primary" onclick="refreshKeywords()">Request fresh analysis</button></div>';
      return;
    }
    const res = await fetch('/api/keywords/analysis');
    const data = await res.json();
    document.getElementById('kw-total').textContent = (data.dataSize||0).toLocaleString();
    if (!data.analysis) {
      container.innerHTML = '<div class="loading"><div class="spinner"></div> AI is analysing ' + data.dataSize + ' search terms...</div>';
      setTimeout(loadKeywords, 10000);
      return;
    }
    const a = data.analysis;
    document.getElementById('kw-status').textContent = 'Last analysed: ' + (status.lastAnalysed ? new Date(status.lastAnalysed).toLocaleString('en-GB') : 'just now') + ' · ' + data.dataSize + ' search terms';
    document.getElementById('kw-waste').textContent = a.wasteReduction?.totalWasted || '—';
    document.getElementById('kw-opps').textContent = a.newKeywords?.totalOpportunities || '—';
    document.getElementById('kw-impact').textContent = a.estimatedWeeklyImpact || '—';
    container.innerHTML = `
      <div class="insight-box" style="margin-bottom:20px">
        <div class="insight-title">✦ AI Summary</div>
        <div class="insight-text">${escHtml(a.summary||'')}</div>
      </div>
      <div class="tabs" id="kw-tabs">
        <button class="tab-btn active" onclick="showKwTab('waste',this)">Wasted spend (${a.wasteReduction?.topWasters?.length||0})</button>
        <button class="tab-btn" onclick="showKwTab('keywords',this)">New keywords (${a.newKeywords?.totalOpportunities||0})</button>
        <button class="tab-btn" onclick="showKwTab('bids',this)">Bid changes (${a.bidChanges?.length||0})</button>
        <button class="tab-btn" onclick="showKwTab('insights',this)">Portfolio insights</button>
      </div>
      <div id="kwt-waste">
        <div class="section-header">
          <div><div class="section-title">Wasting search terms</div><div class="section-sub">Zero conversions — add as negative keywords</div></div>
          <div style="display:flex;gap:8px"><button class="btn btn-ghost" onclick="exportWasters()">Export CSV</button></div>
        </div>
        <div class="table-card">
          <div style="overflow-x:auto"><table>
            <thead><tr><th>Search term</th><th>Campaign</th><th>Spend wasted</th><th>Reason</th><th>Action</th></tr></thead>
            <tbody>${(a.wasteReduction?.topWasters||[]).map(w=>`<tr><td class="mono" style="font-weight:600">${escHtml(w.searchTerm)}</td><td style="font-size:12px;color:var(--text2)">${escHtml(w.campaign)}</td><td class="mono" style="color:var(--red);font-weight:600">${escHtml(w.spend)}</td><td style="font-size:12px;color:var(--text3)">${escHtml(w.reason)}</td><td><button class="btn btn-red" style="font-size:12px">Add negative</button></td></tr>`).join('')||'<tr><td colspan="5"><div class="empty">No wasting terms found</div></td></tr>'}</tbody>
          </table></div>
        </div>
      </div>
      <div id="kwt-keywords" style="display:none">
        <div class="section-header">
          <div><div class="section-title">New keyword opportunities</div><div class="section-sub">Converting search terms not yet as exact match keywords</div></div>
          <div style="display:flex;gap:8px"><button class="btn btn-ghost" onclick="exportOpps()">Export CSV</button></div>
        </div>
        <div class="table-card">
          <div style="overflow-x:auto"><table>
            <thead><tr><th>Search term</th><th>Campaign</th><th>Type</th><th>Purchases</th><th>Sales</th><th>Recommendation</th><th>Action</th></tr></thead>
            <tbody>${(a.newKeywords?.topOpportunities||[]).map(k=>`<tr><td class="mono" style="font-weight:600">${escHtml(k.searchTerm)}</td><td style="font-size:12px;color:var(--text2)">${escHtml(k.campaign)}</td><td>${k.isAuto?'<span class="badge badge-blue" style="font-size:10px">Auto → Manual</span>':'<span class="badge" style="background:var(--surface3);color:var(--text3);font-size:10px">Manual</span>'}</td><td class="mono" style="color:var(--green);font-weight:600">${escHtml(String(k.purchases))}</td><td class="mono" style="color:var(--green)">${escHtml(k.sales)}</td><td style="font-size:12px">${escHtml(k.recommendation)}</td><td><button class="btn btn-green" style="font-size:12px">Add keyword</button></td></tr>`).join('')||'<tr><td colspan="7"><div class="empty">No opportunities found</div></td></tr>'}</tbody>
          </table></div>
        </div>
      </div>
      <div id="kwt-bids" style="display:none">
        <div class="section-header"><div class="section-title">Bid change recommendations</div></div>
        <div class="table-card">
          <div style="overflow-x:auto"><table>
            <thead><tr><th>Keyword</th><th>Campaign</th><th>Issue</th><th>Recommendation</th><th>Expected outcome</th><th>Action</th></tr></thead>
            <tbody>${(a.bidChanges||[]).map(b=>`<tr><td class="mono">${escHtml(b.keyword)}</td><td style="font-size:12px">${escHtml(b.campaign)}</td><td style="font-size:12px;color:var(--red)">${escHtml(b.currentIssue)}</td><td style="font-size:12px">${escHtml(b.recommendation)}</td><td style="font-size:12px;color:var(--green)">${escHtml(b.expectedOutcome)}</td><td><button class="btn btn-amber" style="font-size:12px">Apply</button></td></tr>`).join('')||'<tr><td colspan="6"><div class="empty">No bid changes recommended</div></td></tr>'}</tbody>
          </table></div>
        </div>
      </div>
      <div id="kwt-insights" style="display:none">
        <div class="insight-box"><div class="insight-title">✦ Portfolio patterns</div><div class="insight-text">${escHtml(a.portfolioInsights?.patterns||'')}</div></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px">
          <div class="metric-card success"><div class="metric-label">Top performing</div><div class="metric-value" style="font-size:16px">${escHtml(a.portfolioInsights?.topPerforming||'—')}</div></div>
          <div class="metric-card alert"><div class="metric-label">Needs attention</div><div class="metric-value" style="font-size:16px">${escHtml(a.portfolioInsights?.needsAttention||'—')}</div></div>
        </div>
      </div>`;
  } catch(e) {
    container.innerHTML = '<div class="empty">Error: ' + e.message + '</div>';
  }
}

function showKwTab(tab, btn) {
  ['waste','keywords','bids','insights'].forEach(t => { const el = document.getElementById('kwt-'+t); if(el) el.style.display = t===tab?'':'none'; });
  document.querySelectorAll('#kw-tabs .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

async function refreshKeywords() {
  document.getElementById('kw-status').textContent = 'Requesting fresh report...';
  document.getElementById('kw-container').innerHTML = '<div class="loading"><div class="spinner"></div> Requesting search term report from Amazon...</div>';
  await fetch('/api/keywords/refresh', { method: 'POST' });
  setTimeout(loadKeywords, 3000);
}
