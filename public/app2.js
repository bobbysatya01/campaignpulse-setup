
// ── Export ─────────────────────────────────────────────────────────────────
function exportCSV() {
  if (!allCampaigns.length) { alert('No data to export'); return; }
  const headers = ['Campaign','Portfolio','Agent','Type','State','Daily Budget','Spend','Revenue','ACOS','Impressions','Clicks','CTR','Conversions','Budget Remaining','Budget %'];
  const rows = allCampaigns.map(c => [c.name,c.portfolio||'',c.agent||'',c.targetingType||'',c.state,c.dailyBudget,c.spend||0,c.sales||0,c.acos+'%',c.impressions||0,c.clicks||0,(c.ctr||'0')+'%',c.conversions||0,c.budgetRemaining,c.budgetPct+'%']);
  const exportDate = document.getElementById('history-date-select')?.value || new Date().toISOString().split('T')[0];
  downloadCSV(headers, rows, 'fksports-campaigns-' + exportDate + '.csv');
}

function exportReportCSV() {
  const log = appData.exhaustionLog || [];
  if (!log.length) { alert('No report data'); return; }
  const headers = ['Date','Campaign','Portfolio','Agent','Budget','Ran out at','ACOS','Est. missed','Resolved at','Gap','Budget added','Action'];
  const rows = log.map(e => [e.date,e.campaign,e.portfolio||'',e.agent||'',e.budget,e.time,e.acos,e.missed,e.resolvedAt||'',e.gap||'',e.added,e.action]);
  downloadCSV(headers, rows, 'fksports-budget-report-' + new Date().toISOString().split('T')[0] + '.csv');
}

function exportWasters() {
  fetch('/api/keywords/analysis').then(r=>r.json()).then(data => {
    if (!data.analysis) return;
    const headers = ['Search Term','Campaign','Spend Wasted','Recommendation','Reason'];
    const rows = (data.analysis.wasteReduction?.topWasters||[]).map(w=>[w.searchTerm,w.campaign,w.spend,w.recommendation,w.reason]);
    downloadCSV(headers, rows, 'fksports-negative-keywords-' + new Date().toISOString().split('T')[0] + '.csv');
  });
}

function exportOpps() {
  fetch('/api/keywords/analysis').then(r=>r.json()).then(data => {
    if (!data.analysis) return;
    const headers = ['Search Term','Campaign','Is Auto','Purchases','Sales','Recommendation'];
    const rows = (data.analysis.newKeywords?.topOpportunities||[]).map(k=>[k.searchTerm,k.campaign,k.isAuto?'Yes':'No',k.purchases,k.sales,k.recommendation]);
    downloadCSV(headers, rows, 'fksports-new-keywords-' + new Date().toISOString().split('T')[0] + '.csv');
  });
}

function downloadCSV(headers, rows, filename) {
  const csv = [headers,...rows].map(r=>r.map(v=>'"'+String(v||'').replace(/"/g,'""')+'"').join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download = filename; a.click();
}

function escHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}



// ── Underperforming / Stuck Campaigns ─────────────────────────────────────
async function loadStuckCampaigns() {
  try {
    const res = await fetch('/api/stuck-campaigns');
    const data = await res.json();
    const noActivity = data.noActivity || [];
    const noRevenue = data.noRevenue || [];
    const total = noActivity.length + noRevenue.length;

    document.getElementById('stuck-no-activity').textContent = noActivity.length;
    document.getElementById('stuck-no-revenue').textContent = noRevenue.length;
    document.getElementById('stuck-na-count').textContent = noActivity.length;
    document.getElementById('stuck-nr-count').textContent = noRevenue.length;

    // Update nav badge
    const badge = document.getElementById('stuck-badge');
    if (total > 0) { badge.textContent = total; badge.style.display = ''; }
    else badge.style.display = 'none';

    if (data.days < 3) {
      const msg = '<div class="empty" style="padding:40px"><div style="font-size:32px;margin-bottom:12px">⏳</div><div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:6px">Building history...</div><div style="font-size:13px;color:var(--text3)">Need at least 3 days of data. Currently have ' + (data.daysOfData||0) + ' day(s). Check back tomorrow.</div></div>';
      document.getElementById('stuck-na-table').innerHTML = '<tr><td colspan="8">' + msg + '</td></tr>';
      document.getElementById('stuck-nr-table').innerHTML = '<tr><td colspan="8">' + msg + '</td></tr>';
      return;
    }

    // No activity table
    const naTbody = document.getElementById('stuck-na-table');
    naTbody.innerHTML = noActivity.length ? noActivity.map(function(c) {
      return '<tr>' +
        '<td><div class="camp-name">' + escHtml(c.name) + '</div></td>' +
        '<td style="font-size:12px">' + escHtml(c.portfolio||'—') + '</td>' +
        '<td>' + (c.targetingType==='auto'?'<span class="badge badge-blue" style="font-size:10px">Auto</span>':'<span class="badge" style="background:var(--surface3);color:var(--text3);font-size:10px">Manual</span>') + '</td>' +
        '<td class="mono" style="color:var(--red);font-weight:600">' + c.daysNoActivity + ' days</td>' +
        '<td class="mono">£' + c.totalSpend + '</td>' +
        '<td class="mono">£' + c.lastBudget + '</td>' +
        '<td style="font-size:12px;color:var(--text3)">Zero impressions — bid too low or targeting broken</td>' +
        '<td><div class="ag"><button class="btn btn-red" style="font-size:11px">Pause</button><button class="btn btn-ghost" style="font-size:11px">Review</button></div></td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="8"><div class="empty">No campaigns with 3+ days zero activity</div></td></tr>';

    // No revenue table
    const nrTbody = document.getElementById('stuck-nr-table');
    nrTbody.innerHTML = noRevenue.length ? noRevenue.map(function(c) {
      return '<tr>' +
        '<td><div class="camp-name">' + escHtml(c.name) + '</div></td>' +
        '<td style="font-size:12px">' + escHtml(c.portfolio||'—') + '</td>' +
        '<td>' + (c.targetingType==='auto'?'<span class="badge badge-blue" style="font-size:10px">Auto</span>':'<span class="badge" style="background:var(--surface3);color:var(--text3);font-size:10px">Manual</span>') + '</td>' +
        '<td class="mono" style="color:var(--red);font-weight:600">' + c.daysNoRevenue + ' days</td>' +
        '<td class="mono" style="color:var(--red);font-weight:600">£' + c.totalWastedSpend + '</td>' +
        '<td class="mono ' + (parseFloat(c.avgAcos)>35?'acos-high':parseFloat(c.avgAcos)>12?'acos-warn':'') + '">' + c.avgAcos + '%</td>' +
        '<td style="font-size:12px;color:var(--text3)">Spend with zero attributed revenue</td>' +
        '<td><div class="ag"><button class="btn btn-red" style="font-size:11px">Pause</button><button class="btn btn-ghost" style="font-size:11px">Review</button></div></td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="8"><div class="empty">No campaigns with 7+ days spend and no revenue</div></td></tr>';

  } catch(e) {
    console.error('Stuck campaigns error:', e);
  }
}

function showStuckTab(tab, btn) {
  document.getElementById('stuck-no-activity-tab').style.display = tab === 'no-activity' ? '' : 'none';
  document.getElementById('stuck-no-revenue-tab').style.display = tab === 'no-revenue' ? '' : 'none';
  document.querySelectorAll('#page-stuck .tab-btn').forEach(function(b){ b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
}

// ── Daily History ─────────────────────────────────────────────────────────
async function loadHistoryDates() {
  try {
    const res = await fetch('/api/snapshots');
    const data = await res.json();
    const sel = document.getElementById('history-date-select');
    sel.innerHTML = '<option value="">Select a date...</option>';
    data.dates.forEach(function(d) {
      // Fix timezone issue - add T00:00:00 to force local date parsing
      const dateStr = typeof d.date === 'string' ? d.date.split('T')[0] : String(d.date).split('T')[0];
      const date = new Date(dateStr + 'T12:00:00');
      const label = date.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
      const m = d.metrics || {};
      const opt = document.createElement('option');
      opt.value = dateStr;
      opt.textContent = label + ' — £' + (m.totalRevenue||'0') + ' rev · £' + (m.totalSpend||'0') + ' spend · ' + (m.blendedAcos||'0') + '% ACOS';
      sel.appendChild(opt);
    });
    if (data.dates.length === 0) {
      document.getElementById('history-placeholder').innerHTML = '<div class="empty" style="padding:60px"><div style="font-size:32px;margin-bottom:16px">⏳</div><div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px">No history yet</div><div style="font-size:13px;color:var(--text3)">Data is being saved automatically every sync. Check back later today.</div></div>';
    }
  } catch(e) {
    console.error('History dates error:', e);
  }
}

window.historyData = null;
window.historySortState = { col: 'spend', dir: -1 };

function sortHistoryCol(col) {
  if (historySortState.col === col) historySortState.dir *= -1;
  else { historySortState.col = col; historySortState.dir = -1; }
  document.querySelectorAll('[id^="hs-"]').forEach(function(el){ el.textContent=''; });
  const ind = document.getElementById('hs-' + col);
  if (ind) ind.textContent = historySortState.dir === -1 ? ' ↓' : ' ↑';
  if (window.historyData) filterHistoryByAgent();
}

function filterHistoryByAgent() {
  if (!window.historyData) return;
  const agentFilter = document.getElementById('history-agent-filter')?.value || '';
  let camps = (window.historyData.campaigns) || [];

  // Populate agent filter options if empty
  const sel = document.getElementById('history-agent-filter');
  if (sel && sel.options.length <= 1) {
    const agents = [...new Set(camps.map(function(c){
      const parts = (c.name||'').split(/[|@]/);
      const name = parts[0].trim();
      return name.length > 0 && name.length < 30 ? name : '';
    }).filter(Boolean))].sort();
    agents.forEach(function(a) {
      const o = document.createElement('option');
      o.value = a; o.textContent = a;
      sel.appendChild(o);
    });
  }

  if (agentFilter) {
    camps = camps.filter(function(c){
      const parts = (c.name||'').split(/[|@]/);
      return parts[0].trim() === agentFilter;
    });
  }

  // Re-render tables with filtered camps
  renderHistoryCampaignsTable(camps);
  renderHistorySNRTable(camps);
  renderHistoryNoActivityTable(camps);
  // Render exhaustion log
  const exLog = window.historyData.exhaustionLog || window.historyData.exhaustion_log || [];
  const exTbody = document.getElementById('history-exhaustion-table');
  if (exTbody) {
    const col = exhaustionSortState.col;
    const dir = exhaustionSortState.dir;
    const sortedEx = exLog.slice().sort(function(a,b){
      const va = col==='budget'?parseFloat((a.budget||'0').replace(/[^0-9.]/g,'')):col==='missed'?parseFloat((a.missed||'0').replace(/[^0-9.]/g,'')):col==='acos'?parseFloat(a.acos||0):col==='gap'?parseInt(a.gap||0):(a[col]||'');
      const vb = col==='budget'?parseFloat((b.budget||'0').replace(/[^0-9.]/g,'')):col==='missed'?parseFloat((b.missed||'0').replace(/[^0-9.]/g,'')):col==='acos'?parseFloat(b.acos||0):col==='gap'?parseInt(b.gap||0):(b[col]||'');
      return va < vb ? dir : va > vb ? -dir : 0;
    });
    exTbody.innerHTML = sortedEx.length ? sortedEx.map(function(e) {
      return '<tr><td>' + (e.time||'') + '</td><td><div class="camp-name">' + (e.campaign||'') + '</div></td><td class="mono">£' + (e.budget||'0') + '</td><td class="mono">' + (e.acos||'0') + '</td><td class="mono">£' + (e.missed||'0') + '</td><td class="mono">' + (e.gap||'—') + '</td><td>' + (e.resolvedAt||'—') + '</td><td>' + (e.action||'Pending') + '</td></tr>';
    }).join('') : '<tr><td colspan="8"><div class="empty">No exhaustion events on this day</div></td></tr>';
  }
}

function renderHistoryCampaignsTable(camps) {
  if (!camps || !camps.length) { document.getElementById('history-table').innerHTML = '<tr><td colspan="12"><div class="empty">No campaign data</div></td></tr>'; return; }
  const tbody = document.getElementById('history-table');
  const col = historySortState.col;
  const dir = historySortState.dir;
  const sorted = camps.slice().sort(function(a,b){
    const va = col==='name'?(a.name||''):col==='spend'?(a.spend||0):col==='sales'?(a.sales||0):col==='acos'?(a.acos||0):col==='impressions'?(a.impressions||0):col==='clicks'?(a.clicks||0):(a.conversions||0);
    const vb = col==='name'?(b.name||''):col==='spend'?(b.spend||0):col==='sales'?(b.sales||0):col==='acos'?(b.acos||0):col==='impressions'?(b.impressions||0):col==='clicks'?(b.clicks||0):(b.conversions||0);
    return va < vb ? dir : va > vb ? -dir : 0;
  });
  tbody.innerHTML = sorted.map(function(c) {
    const acosClass = c.acos > 35 ? 'acos-high' : c.acos > 25 ? 'acos-warn' : c.acos > 0 ? 'acos-ok' : '';
    return '<tr><td><div class="camp-name">' + escHtml(c.name) + '</div></td><td style="font-size:12px">' + escHtml(c.portfolio||'—') + '</td><td>' + (c.targetingType==='auto'?'<span class="badge badge-blue" style="font-size:10px">Auto</span>':'<span class="badge" style="background:var(--surface3);color:var(--text3);font-size:10px">Manual</span>') + '</td><td class="mono">£' + (c.dailyBudget||0) + '</td><td class="mono">' + (c.impressions||0).toLocaleString() + '</td><td class="mono">' + (c.clicks||0) + '</td><td class="mono">' + (c.ctr||'0') + '%</td><td class="mono">' + (c.conversions||0) + '</td><td class="mono" style="color:var(--green)">£' + (c.sales||0) + '</td><td class="mono">£' + (c.spend||0) + '</td><td class="mono ' + acosClass + '">' + (c.acos>0?c.acos+'%':'—') + '</td><td>' + (c.budgetRemaining<=0.01&&c.dailyBudget>0?'<span class="badge badge-red">Out of budget</span>':c.acos>35&&c.spend>5?'<span class="badge badge-red">ACOS high</span>':'<span class="badge badge-green">Healthy</span>') + '</td></tr>';
  }).join('') || '<tr><td colspan="12"><div class="empty">No campaign data</div></td></tr>';
}

function renderHistorySNRTable(camps) {
  const snr = camps.filter(function(c){ return c.spend > 0 && (c.sales === 0 || c.sales === null); });
  const snrSpend = snr.reduce(function(s,c){ return s+(c.spend||0); }, 0).toFixed(2);
  const ins = document.getElementById('history-snr-insight');
  if (ins) ins.textContent = snr.length + ' campaigns spent £' + snrSpend + ' with zero attributed revenue on this day.';
  const badge = document.getElementById('h-snr-badge');
  if (badge) badge.textContent = snr.length;
  const snrTbody = document.getElementById('history-snr-table');
  snrTbody.innerHTML = snr.sort(function(a,b){ return (b.spend||0)-(a.spend||0); }).map(function(c) {
    return '<tr><td><div class="camp-name">' + escHtml(c.name) + '</div></td><td style="font-size:12px">' + escHtml(c.portfolio||'—') + '</td><td>' + (c.targetingType==='auto'?'<span class="badge badge-blue" style="font-size:10px">Auto</span>':'<span class="badge" style="background:var(--surface3);color:var(--text3);font-size:10px">Manual</span>') + '</td><td class="mono" style="color:var(--red);font-weight:600">£' + (c.spend||0) + '</td><td class="mono">' + (c.impressions||0).toLocaleString() + '</td><td class="mono">' + (c.clicks||0) + '</td><td class="mono">' + (c.ctr||'0') + '%</td><td class="mono">' + (c.conversions||0) + '</td><td><span class="badge badge-red">Wasted spend</span></td></tr>';
  }).join('') || '<tr><td colspan="9"><div class="empty">No wasted spend on this day</div></td></tr>';
}

function renderHistoryNoActivityTable(camps) {
  const noAct = camps.filter(function(c){ return c.impressions === 0 && (c.spend === 0 || c.spend === null); });
  const noActBadge = document.getElementById('h-no-activity-badge');
  if (noActBadge) noActBadge.textContent = noAct.length;
  const noActTbody = document.getElementById('history-no-activity-table');
  noActTbody.innerHTML = noAct.length ? noAct.map(function(c) {
    return '<tr><td><div class="camp-name">' + escHtml(c.name) + '</div></td><td style="font-size:12px">' + escHtml(c.portfolio||'—') + '</td><td>' + (c.targetingType==='auto'?'<span class="badge badge-blue" style="font-size:10px">Auto</span>':'<span class="badge" style="background:var(--surface3);color:var(--text3);font-size:10px">Manual</span>') + '</td><td class="mono">£' + (c.dailyBudget||0) + '</td><td class="mono" style="color:var(--text3)">0</td><td class="mono" style="color:var(--text3)">0</td><td class="mono">£' + (c.spend||0) + '</td><td><span class="badge badge-amber">No activity</span></td></tr>';
  }).join('') : '<tr><td colspan="8"><div class="empty">No inactive campaigns on this day</div></td></tr>';
}

async function loadHistoryDate() {
  const date = document.getElementById('history-date-select').value;
  if (!date) return;
  document.getElementById('history-loading').textContent = 'Loading...';
  document.getElementById('history-metrics').style.display = 'none';
  document.getElementById('history-empty').style.display = 'none';
  document.getElementById('history-placeholder').style.display = 'none';
  try {
    const dateClean = String(date).split('T')[0].split(' ')[0];
    const res = await fetch('/api/snapshots/' + dateClean);
    if (!res.ok) {
      document.getElementById('history-empty').style.display = '';
      document.getElementById('history-metrics').style.display = '';
    document.getElementById('history-loading').textContent = '';
    filterHistoryByAgent();
      return;
    }
    const data = await res.json();
    window.historyData = data;
    const m = data.metrics || {};
    document.getElementById('h-revenue').textContent = '£' + (m.totalRevenue||'0');
    document.getElementById('h-spend').textContent = '£' + (m.totalSpend||'0');
    document.getElementById('h-acos').textContent = (m.blendedAcos||'0') + '%';
    document.getElementById('h-wasted').textContent = '£' + (m.totalWastedSpend||'0');
    document.getElementById('h-wasted-d').textContent = (m.spendNoRevenue||'0') + ' campaigns with spend, no revenue';
    document.getElementById('h-active').textContent = m.activeCampaigns||'0';
    document.getElementById('h-oob').textContent = (data.exhaustionLog||[]).length;
    document.getElementById('h-snr').textContent = m.spendNoRevenue||'0';
    const camps = data.campaigns || [];
    // Campaigns table
    const tbody = document.getElementById('history-table');
    tbody.innerHTML = sorted.map(function(c) {
      const acosClass = c.acos > 35 ? 'acos-high' : c.acos > 25 ? 'acos-warn' : c.acos > 0 ? 'acos-ok' : '';
      return '<tr><td><div class="camp-name">' + escHtml(c.name) + '</div></td><td style="font-size:12px">' + escHtml(c.portfolio||'—') + '</td><td>' + (c.targetingType==='auto'?'<span class="badge badge-blue" style="font-size:10px">Auto</span>':'<span class="badge" style="background:var(--surface3);color:var(--text3);font-size:10px">Manual</span>') + '</td><td class="mono">£' + (c.dailyBudget||0) + '</td><td class="mono">' + (c.impressions||0).toLocaleString() + '</td><td class="mono">' + (c.clicks||0) + '</td><td class="mono">' + (c.ctr||'0') + '%</td><td class="mono">' + (c.conversions||0) + '</td><td class="mono" style="color:var(--green)">£' + (c.sales||0) + '</td><td class="mono">£' + (c.spend||0) + '</td><td class="mono ' + acosClass + '">' + (c.acos>0?c.acos+'%':'—') + '</td><td>' + (c.budgetRemaining<=0.01&&c.dailyBudget>0?'<span class="badge badge-red">Out of budget</span>':c.acos>35&&c.spend>5?'<span class="badge badge-red">ACOS high</span>':'<span class="badge badge-green">Healthy</span>') + '</td></tr>';
    }).join('') || '<tr><td colspan="12"><div class="empty">No campaign data</div></td></tr>';
    // Spend no revenue table
    const snr = camps.filter(function(c){ return c.spend > 0 && (c.sales === 0 || c.sales === null); });
    document.getElementById('history-snr-insight').textContent = snr.length + ' campaigns spent £' + snr.reduce(function(s,c){ return s+(c.spend||0); }, 0).toFixed(2) + ' with zero attributed revenue on this day.';
    document.getElementById('h-snr-badge').textContent = snr.length;
    const snrTbody = document.getElementById('history-snr-table');
    snrTbody.innerHTML = snr.sort(function(a,b){ return (b.spend||0)-(a.spend||0); }).map(function(c) {
      return '<tr><td><div class="camp-name">' + escHtml(c.name) + '</div></td><td style="font-size:12px">' + escHtml(c.portfolio||'—') + '</td><td>' + (c.targetingType==='auto'?'<span class="badge badge-blue" style="font-size:10px">Auto</span>':'<span class="badge" style="background:var(--surface3);color:var(--text3);font-size:10px">Manual</span>') + '</td><td class="mono" style="color:var(--red);font-weight:600">£' + (c.spend||0) + '</td><td class="mono">' + (c.impressions||0).toLocaleString() + '</td><td class="mono">' + (c.clicks||0) + '</td><td class="mono">' + (c.ctr||'0') + '%</td><td class="mono">' + (c.conversions||0) + '</td><td><span class="badge badge-red">Wasted spend</span></td></tr>';
    }).join('') || '<tr><td colspan="9"><div class="empty">No wasted spend on this day</div></td></tr>';
    // No activity table
    const noAct = camps.filter(function(c){ return c.impressions === 0 && (c.spend === 0 || c.spend === null); });
    document.getElementById('history-na-insight').textContent = noAct.length + ' campaign' + (noAct.length !== 1 ? 's' : '') + ' had zero impressions and zero spend on this day. Review bids, targeting, or consider pausing.';
    document.getElementById('h-na-badge').textContent = noAct.length;
    const noActTbody = document.getElementById('history-no-activity-table');
    noActTbody.innerHTML = noAct.length ? noAct.map(function(c) {
      return '<tr><td><div class="camp-name">' + escHtml(c.name) + '</div></td><td style="font-size:12px">' + escHtml(c.portfolio||'—') + '</td><td>' + (c.targetingType==='auto'?'<span class="badge badge-blue" style="font-size:10px">Auto</span>':'<span class="badge" style="background:var(--surface3);color:var(--text3);font-size:10px">Manual</span>') + '</td><td class="mono">£' + (c.dailyBudget||0) + '</td><td class="mono" style="color:var(--text3)">0</td><td class="mono" style="color:var(--text3)">0</td><td class="mono">£' + (c.spend||0) + '</td><td><span class="badge badge-amber">No activity</span></td></tr>';
    }).join('') : '<tr><td colspan="8"><div class="empty">No inactive campaigns on this day</div></td></tr>';

    // Exhaustion log table
    const exTbody = document.getElementById('history-exhaustion-table');
    exTbody.innerHTML = (data.exhaustionLog||[]).map(function(e) {
      return '<tr><td class="mono" style="color:var(--red);font-weight:600">' + (e.time||'—') + '</td><td><div class="camp-name">' + escHtml(e.campaign||'—') + '</div></td><td style="font-size:12px">' + escHtml(e.portfolio||'—') + '</td><td style="font-size:12px">' + escHtml(e.agent||'—') + '</td><td class="mono">' + (e.budget||'—') + '</td><td class="mono">' + (e.acos||'—') + '</td><td class="mono" style="color:var(--red)">' + (e.missed||'—') + '</td><td class="mono" style="color:var(--green)">' + (e.resolvedAt||'—') + '</td><td class="mono" style="color:var(--amber);font-weight:600">' + (e.gap||'—') + '</td><td><span class="badge ' + (e.action==='Budget added'?'badge-green':e.action==='Dismissed'?'badge-red':'badge-amber') + '">' + (e.action||'—') + '</span></td></tr>';
    }).join('') || '<tr><td colspan="10"><div class="empty">No exhaustion events on this day</div></td></tr>';
    document.getElementById('history-metrics').style.display = '';
    document.getElementById('history-metrics').style.display = '';
    document.getElementById('history-loading').textContent = '';
    filterHistoryByAgent();
  } catch(e) {
    document.getElementById('history-empty').style.display = '';
    document.getElementById('history-metrics').style.display = '';
    document.getElementById('history-loading').textContent = '';
    filterHistoryByAgent();
  }
}

function showHistoryTab(tab, btn) {
  document.getElementById('history-campaigns-tab').style.display = tab==='campaigns'?'':'none';
  document.getElementById('history-snr-tab').style.display = tab==='spend_no_revenue'?'':'none';
  document.getElementById('history-no-activity-tab').style.display = tab==='no_activity'?'':'none';
  document.getElementById('history-exhaustion-tab').style.display = tab==='exhaustion'?'':'none';
  document.querySelectorAll('#page-history .tab-btn').forEach(function(b){ b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
}


// ── Tasks ──────────────────────────────────────────────────────────────────
window.allTasks = [];
window.taskTab = 'open';
window.selectedAgent = '';

function renderAgentTabs() {
  const container = document.getElementById('agent-tabs');
  if (!container) return;
  const agents = [...new Set(allTasks.map(function(t){ return getTaskAgent(t); }).filter(Boolean))].sort();
  const allDue = allTasks.filter(function(t){ return t.status==='open'||t.status==='in_progress'; }).length;

  const btnStyle = function(selected) {
    return 'padding:10px 20px;border-radius:10px;border:2px solid ' + (selected?'#e8391d':'#ddd') + ';background:' + (selected?'#e8391d':'white') + ';color:' + (selected?'white':'#333') + ';font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;position:relative;margin:2px';
  };

  // Build HTML directly - no createElement needed
  let html = '<button style="' + btnStyle(selectedAgent==='') + '" onclick="selectAgent(this,\'\')">All agents<br><span style="font-size:11px;font-weight:400;opacity:0.8">' + allDue + ' due</span></button>';

  agents.forEach(function(agent) {
    const due = allTasks.filter(function(t){ return getTaskAgent(t)===agent && (t.status==='open'||t.status==='in_progress'); }).length;
    const paused = allTasks.filter(function(t){ return getTaskAgent(t)===agent && t.status==='paused'; }).length;
    const badge = due > 0 ? '<span style="position:absolute;top:-5px;right:-5px;background:#c0392b;color:white;font-size:9px;font-weight:700;padding:1px 5px;border-radius:8px">' + due + '</span>' : '';
    html += '<button style="' + btnStyle(selectedAgent===agent) + '" data-agent="' + agent.replace(/"/g,'') + '" onclick="selectAgent(this,this.getAttribute(\'data-agent\'))">' + agent + badge + '<br><span style="font-size:11px;font-weight:400;opacity:0.8">' + due + ' due</span></button>';
  });

  container.innerHTML = html;
}

function selectAgent(btnEl, agent) {
  selectedAgent = agent;
  // Update button styles
  document.querySelectorAll('#agent-tabs button').forEach(function(b){ b.style.background='white'; b.style.color='#333'; b.style.borderColor='#ddd'; });
  if (btnEl) { btnEl.style.background='#e8391d'; btnEl.style.color='white'; btnEl.style.borderColor='#e8391d'; }
  renderTasks(taskTab);
}

async function loadTasks() {
  try {
    const res = await fetch('/api/tasks');
    const data = await res.json();
    allTasks = data.tasks || [];
    // Populate agent filter
    const agentSel = document.getElementById('task-agent-filter');
    if (agentSel) {
      const currentVal = agentSel.value;
      agentSel.innerHTML = '<option value="">All agents</option>';
      const agents = [...new Set(allTasks.map(function(t){ return t.agent_name||''; }).filter(Boolean))].sort();
      agents.forEach(function(a){ const o=document.createElement('option');o.value=a;o.textContent=a;if(a===currentVal)o.selected=true;agentSel.appendChild(o); });
    }

    const today = new Date().toISOString().split('T')[0];
    const open = allTasks.filter(function(t){ return t.status === 'open'; });
    const inprog = allTasks.filter(function(t){ return t.status === 'in_progress'; });
    const complete = allTasks.filter(function(t){ return t.status === 'complete' && (t.resolved_at||'').startsWith(today); });
    const overdue = allTasks.filter(function(t){ return (t.status === 'open' || t.status === 'in_progress') && t.days_persisted >= 2; });

    document.getElementById('task-open').textContent = open.length;
    document.getElementById('task-inprogress').textContent = inprog.length;
    document.getElementById('task-complete').textContent = complete.length;
    document.getElementById('task-overdue').textContent = overdue.length;

    const badge = document.getElementById('tasks-badge');
    const urgent = open.length + overdue.length;
    if (urgent > 0) { badge.textContent = urgent; badge.style.display = ''; }
    else badge.style.display = 'none';

    renderAgentTabs();
    renderTasks(taskTab);
  } catch(e) {
    document.getElementById('tasks-container').innerHTML = '<div class="empty">Error loading tasks: ' + e.message + '</div>';
  }
}

function showTaskTab(tab, btn) {
  taskTab = tab;
  document.querySelectorAll('#page-tasks .tab-btn').forEach(function(b){ b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderTasks(tab);
}

function renderTasks(tab) {
  let filtered = allTasks;
  if (tab === 'open') filtered = allTasks.filter(function(t){ return t.status === 'open' || t.status === 'in_progress'; });
  else if (tab === 'complete') filtered = allTasks.filter(function(t){ return t.status === 'complete'; });

  const container = document.getElementById('tasks-container');
  if (!filtered.length) {
    container.innerHTML = '<div class="empty" style="padding:50px"><div style="font-size:28px;margin-bottom:12px">✅</div><div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:6px">' + (tab === 'open' ? 'No open tasks' : 'No tasks yet') + '</div><div style="font-size:12px;color:var(--text3)">Tasks are created daily at 9am based on campaign performance history.<br>Use "Run now" to test the scheduler.</div></div>';
    return;
  }

  container.innerHTML = filtered.map(function(t) {
    const isOverdue = t.days_persisted >= 2 && (t.status === 'open' || t.status === 'in_progress');
    const statusColors = { open: 'badge-red', in_progress: 'badge-amber', complete: 'badge-green', escalated: 'badge-red' };
    const statusLabels = { open: 'Open', in_progress: 'In Progress', complete: 'Complete', escalated: 'Escalated' };
    const problemIcon = t.problem_type === 'no_activity' ? '😴' : '💸';
    const dateStr = typeof t.created_date === 'string' ? t.created_date.split('T')[0] : String(t.created_date).split('T')[0];

    return '<div class="ai-card" style="' + (isOverdue ? 'border-left:3px solid var(--red)' : '') + '">' +
      '<div class="ai-header">' +
        '<div class="ai-icon">' + problemIcon + '</div>' +
        '<div style="flex:1">' +
          '<div class="ai-title">' + escHtml(t.campaign_name) + '</div>' +
          '<div class="ai-sub">Agent: ' + escHtml(t.agent_name||'Unassigned') + ' · Portfolio: ' + escHtml(t.portfolio||'—') + ' · Created: ' + dateStr + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:center">' +
          (isOverdue ? '<span class="badge badge-red">Day ' + t.days_persisted + ' — Overdue</span>' : '') +
          '<span class="badge ' + (statusColors[t.status]||'badge-blue') + '">' + (statusLabels[t.status]||t.status) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="ai-desc">' + escHtml(t.problem_detail||'') + '</div>' +
      (t.agent_notes ? '<div style="background:var(--blue-light);border:1px solid rgba(26,111,189,0.15);border-radius:8px;padding:8px 12px;font-size:12px;color:var(--blue);margin-bottom:12px"><strong>Agent notes:</strong> ' + escHtml(t.agent_notes) + '</div>' : '') +
      (function() {
        if (t.status === 'complete') {
          const rt = t.resolved_at ? new Date(t.resolved_at).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'}) : '';
          return '<div style="font-size:12px;color:var(--green)">Resolved' + (rt ? ' at ' + rt : '') + '</div>';
        }
        const wip = '<button class="btn btn-amber" style="font-size:12px" onclick="updateTask('+t.id+',\"in_progress\",\"\")">Working on it</button>';
        const done = '<button class="btn btn-green" style="font-size:12px" onclick="promptTaskComplete('+t.id+')">Mark complete</button>';
        const paused = '<button class="btn btn-red" style="font-size:12px" onclick="updateTask('+t.id+',\"complete\",\"Campaign paused\")">Paused campaign</button>';
        return '<div class="ag">' + wip + done + paused + '</div>';
      }()) +
    '</div>';
  }).join('');
}

async function completeTask(taskId) {
  await updateTask(taskId, 'complete', 'Done');
}

function pauseTask(taskId) {
  const reason = prompt('Reason for pausing this campaign:');
  if (reason === null) return;
  fetch('/api/tasks/' + taskId + '/status', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ status: 'paused', pausedReason: reason || 'Campaign paused', notes: reason || 'Campaign paused' })
  }).then(function(){ loadTasks(); });
}

async function archiveTask(taskId) {
  if (!confirm('Archive this task? It will be removed from view but kept in records.')) return;
  try {
    await fetch('/api/tasks/' + taskId + '/archive', { method: 'POST' });
    await loadTasks();
  } catch(e) { alert('Error: ' + e.message); }
}

function dismissTask(taskId) {
  const reasons = ['High ACOS', 'No CVR', 'Test Low Budget', 'Other'];
  const sel = document.createElement('div');
  sel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:white;padding:24px;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.2);z-index:9999;min-width:320px';
  sel.setAttribute('data-task-id', taskId);
  const optionsHtml = reasons.map(function(r){ return '<option>' + r + '</option>'; }).join('');
  sel.innerHTML = '<div style="font-size:15px;font-weight:700;margin-bottom:16px">Why are you dismissing?</div>' +
    '<select id="dismiss-reason-sel" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:10px;font-size:13px">' + optionsHtml + '</select>' +
    '<textarea id="dismiss-other-text" placeholder="Describe reason" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;height:60px;display:none;margin-bottom:10px;resize:vertical"></textarea>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end">' +
    '<button id="dismiss-cancel-btn" class="btn btn-ghost" style="font-size:12px">Cancel</button>' +
    '<button id="dismiss-confirm-btn" class="btn btn-primary" style="font-size:12px">Confirm</button></div>';
  sel.querySelector('#dismiss-reason-sel').onchange = function() {
    sel.querySelector('#dismiss-other-text').style.display = this.value === 'Other' ? '' : 'none';
  };
  sel.querySelector('#dismiss-cancel-btn').onclick = function() { sel.remove(); };
  sel.querySelector('#dismiss-confirm-btn').onclick = function() { confirmDismiss(taskId, sel); };
  document.body.appendChild(sel);
}

async function confirmDismiss(taskId, popup) {
  if (!popup) return;
  const reasonSel = popup.querySelector('#dismiss-reason-sel');
  const otherText = popup.querySelector('#dismiss-other-text');
  const reason = reasonSel.value === 'Other' ? (otherText.value || 'Other') : reasonSel.value;
  popup.remove();
  try {
    await fetch('/api/tasks/' + taskId + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'dismissed', dismissedReason: reason, notes: reason })
    });
    await loadTasks();
  } catch(e) { alert('Error: ' + e.message); }
}

async function updateTask(taskId, status, notes) {
  try {
    await fetch('/api/tasks/' + taskId + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, notes })
    });
    await loadTasks();
  } catch(e) { alert('Error updating task: ' + e.message); }
}

function promptTaskComplete(taskId) {
  const notes = prompt('What did you do to resolve this? (optional)');
  if (notes === null) return;
  updateTask(taskId, 'complete', notes);
}

async function runTasksNow() {
  if (!confirm('Run the task scheduler now? This will check 3 days of history and create tasks. Use for testing only.')) return;
  try {
    await fetch('/api/tasks/run-now', { method: 'POST' });
    setTimeout(loadTasks, 2000);
    alert('Task scheduler triggered. Tasks will appear in a moment.');
  } catch(e) { alert('Error: ' + e.message); }
}

// ── Settings ──────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (!data.settings) return;
    const s = data.settings;
    const fields = document.querySelectorAll('#page-settings input[type="number"]');
    if (s.acosCritical && fields[0]) fields[0].value = s.acosCritical;
    if (s.acosWarning && fields[1]) fields[1].value = s.acosWarning;
    if (s.budgetLowPct && fields[2]) fields[2].value = s.budgetLowPct;
    if (s.pollInterval && fields[3]) fields[3].value = s.pollInterval;
    if (s.maxAlertsPerSync && fields[5]) fields[5].value = s.maxAlertsPerSync;
    if (s.maxAutoAdd && fields[4]) fields[4].value = s.maxAutoAdd;
  } catch(e) { console.error('Load settings error:', e); }
}

async function saveSettings() {
  const fields = document.querySelectorAll('#page-settings input[type="number"]');
  const settings = {
    acosCritical: parseFloat(fields[0]?.value || 35),
    acosWarning: parseFloat(fields[1]?.value || 25),
    budgetLowPct: parseFloat(fields[2]?.value || 20),
    pollInterval: parseInt(fields[3]?.value || 15),
    maxAutoAdd: parseFloat(fields[4]?.value || 50),
    maxAlertsPerSync: parseInt(fields[5]?.value || 5)
  };
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings })
    });
    const data = await res.json();
    if (data.success) {
      const status = document.getElementById('settings-status');
      status.style.display = '';
      setTimeout(function(){ status.style.display = 'none'; }, 3000);
    }
  } catch(e) { alert('Error saving settings: ' + e.message); }
}

function resetSettings() {
  const fields = document.querySelectorAll('#page-settings input[type="number"]');
  const defaults = [35, 25, 20, 15, 50, 5];
  fields.forEach(function(f, i) { f.value = defaults[i] || ''; });
}

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  try { await fetchData(); } catch(e) { console.error('Init error:', e); setTimeout(init, 3000); }
  loadSettings();
}
init();
setInterval(fetchData, 5 * 60 * 1000);
