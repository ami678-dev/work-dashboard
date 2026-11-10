// Headless smoke test for the @local/work-dashboard client module.
// Loads client.js with a stubbed ModuleLoader and React, runs apply() against
// a mock Cordis ctx, then exercises the data pipeline and component output.
// This tests the plugin code only; it is NOT visual verification of the page.

const CLIENT = new URL('../client.js', import.meta.url);
const failures = [];
let passed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name + (detail ? ` :: ${detail}` : ''));
    console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- window / loader stubs (must exist before the module is imported) ----
const storage = new Map();
const windowListeners = {};
const intervals = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  const id = realSetInterval(...args);
  intervals.push(id);
  return id;
};

globalThis.window = {
  __ModuleLoader__: {
    load(config) {
      globalThis.__captured = config;
    },
  },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  innerWidth: 1600,
  innerHeight: 900,
  // Shorten the plugin's timing guards so the stall/idle/stale paths run fast.
  __WDB_TIMING__: { refresh: 300, idle: 1500, stale: 200 },
  addEventListener(type, listener) {
    windowListeners[type] = listener;
  },
  removeEventListener(type) {
    delete windowListeners[type];
  },
};

// ---- React stub ----
const reactStub = {
  Fragment: Symbol('React.Fragment'),
  createElement(type, props, ...children) {
    const flat = children.filter((child) => child !== null && child !== undefined && child !== false);
    return { type, props: props || {}, children: flat.length ? flat : [] };
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    return getSnapshot();
  },
  useRef() {
    return { current: null };
  },
  useState(initial) {
    return [initial, () => {}];
  },
  useEffect() {},
};

// ---- collect plugin config ----
await import(CLIENT.href);
const captured = globalThis.__captured;
check('module registers through __ModuleLoader__', !!captured && captured.id === '@local/work-dashboard', captured && captured.id);
const plugin = captured.factory((name) => {
  if (name === 'react') return reactStub;
  throw new Error(`unexpected require: ${name}`);
});
check('plugin declares inject', JSON.stringify(plugin.inject) === JSON.stringify(['slots', 'locale', 'remote', 'remote.session', 'remote.account']), JSON.stringify(plugin.inject));
check('plugin exports apply', typeof plugin.apply === 'function');

// ---- mock ctx ----
const usageS1 = { uncachedInputTokens: 12345, outputTokens: 678, cacheReadTokens: 90000, cacheWriteTokens: 100 };
const itemsPage1 = [
  { sessionId: 's1', running: true, blank: false, updatedAt: 1000, cwd: '/w/a', projections: { values: { title: 'Alpha', tokenUsage: usageS1 } } },
  { sessionId: 's2', running: false, blank: true, updatedAt: 2000 },
  { sessionId: 's3', running: false, blank: false, origin: 'subagent', updatedAt: 3000 },
];
const itemsPage2 = [
  { sessionId: 's4', running: false, blank: false, updatedAt: 500, projections: { values: { title: null } } },
];

const raised = (output) => [
  { ...itemsPage1[0], projections: { values: { title: 'Alpha', tokenUsage: { ...usageS1, outputTokens: output } } } },
  itemsPage2[0],
];

// Sentinel: the mock answers with a promise that never settles, standing in for a
// Host projection rebuild that hangs a Remote round-trip.
const HANG = Symbol('hang');

const onePage = (items) => ({ ok: true, value: { items } });
const listQueue = [
  { ok: true, value: { items: itemsPage1, cursor: 'p2' } }, // first refresh: paginated
  onePage(itemsPage2),
  onePage(raised(1678)), // ticker poll: output grew, so the speed sampler sees a delta
  onePage(raised(1678)),
  onePage(raised(1678)),
  onePage(raised(1678)),
  onePage(raised(1678)),
  onePage(raised(1678)),
];

const projectionsResponses = {
  s4: { ok: true, value: { asOfSeq: 7, values: { tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 } } } },
};

const watchFrames = [{ status: 'credential-stored', links: { usageUrl: 'u', topUpUrl: 't' }, attempt: null }];
const balanceResult = {
  ok: true,
  value: {
    status: 'ready',
    value: [
      { currency: 'CNY', balance: '12.345' },
      { currency: 'USD', balance: '0.004' },
      { currency: 'CNY', balance: '-2.5' },
    ],
    bonusWallets: [
      { currency: 'CNY', balance: '5' },
      { currency: 'CNY', balance: '0' },
    ],
  },
};

const state = {
  registered: [],
  injectedSlots: [],
  localeDicts: {},
  remoteOn: [],
  ctxOn: [],
  cleanups: [],
  listRequests: [],
  projectionsRequests: [],
  balanceCalls: [],
  watchCalls: 0,
  effects: [],
};

// Real Cordis semantics: `remote.<namespace>` are services in their own right.
// Reading `ctx.remote.account` / `ctx.remote.session` from a fiber that does not
// declare `remote.<namespace>` in its `inject` throws ("cannot get property
// \"remote.*\" without inject") and fails web boot. Guard the namespaces the same
// way here, so a missing injection fails this test instead of only the app.
const remoteNamespaces = {
  session: {
    async list(request) {
      state.listRequests.push(request);
      const next = listQueue.shift();
      if (next === HANG) return new Promise(() => {});
      return next || { ok: false, error: { code: 'exhausted' } };
    },
    async projections(request) {
      state.projectionsRequests.push(request);
      const next = projectionsResponses[request.sessionId];
      if (next === HANG) return new Promise(() => {});
      if (typeof next === 'function') return next(request);
      return next || { ok: true, value: null };
    },
  },
  account: {
    watch() {
      state.watchCalls += 1;
      return (async function* () {
        for (const frame of watchFrames) yield frame;
      })();
    },
    async getBalance(meta) {
      state.balanceCalls.push(meta);
      return balanceResult;
    },
  },
};

const guardedRemote = {
  $on(key, listener) {
    state.remoteOn.push({ key, listener });
    return () => {};
  },
};
for (const name of Object.keys(remoteNamespaces)) {
  Object.defineProperty(guardedRemote, name, {
    configurable: true,
    get() {
      if (!plugin.inject.includes(`remote.${name}`)) {
        throw new Error(`cannot get property "remote.${name}" without inject`);
      }
      return remoteNamespaces[name];
    },
  });
}

const ctx = {
  effect(fn, label) {
    state.effects.push(label);
    const dispose = fn();
    state.cleanups.push({ label, dispose });
    return () => {};
  },
  locale: {
    register(ns, dicts) {
      state.localeDicts[ns] = dicts;
      return () => {};
    },
    bind(ns) {
      const dict = (state.localeDicts[ns] && state.localeDicts[ns].en) || {};
      return (key, params) => {
        let text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
        if (params) {
          for (const name of Object.keys(params)) text = text.split(`{${name}}`).join(String(params[name]));
        }
        return text;
      };
    },
    getSnapshot: () => ({ active: { id: 'en' }, revision: 1 }),
    getLocale: () => ({ active: { id: 'en' }, revision: 1 }),
  },
  slots: {
    inject(key, callback) {
      state.injectedSlots.push(key);
      callback();
      return () => {};
    },
    register(options, Component) {
      state.registered.push({ options, Component });
      return () => {};
    },
  },
  remote: guardedRemote,
  on(event, listener) {
    state.ctxOn.push({ event, listener });
    return () => {};
  },
};

// ---- run the plugin ----
plugin.apply(ctx);
await sleep(80);

// wiring assertions
check('locale namespace registered with en+zh', !!state.localeDicts.workDashboard && !!state.localeDicts.workDashboard.en && !!state.localeDicts.workDashboard.zh);
const enKeys = state.localeDicts.workDashboard ? Object.keys(state.localeDicts.workDashboard.en).sort() : [];
const zhKeys = state.localeDicts.workDashboard ? Object.keys(state.localeDicts.workDashboard.zh).sort() : [];
check('en/zh dictionaries have identical keys', JSON.stringify(enKeys) === JSON.stringify(zhKeys), `${enKeys.length} vs ${zhKeys.length}`);
check('both slots injected', JSON.stringify(state.injectedSlots) === JSON.stringify(['shell.overlay', 'sidebar.footer.action']), JSON.stringify(state.injectedSlots));
check('expected effect labels', JSON.stringify(state.effects) === JSON.stringify([
  'work-dashboard: dictionaries',
  'work-dashboard: viewport',
  'work-dashboard: timers',
  'work-dashboard: sessions',
  'work-dashboard: account',
  'work-dashboard: overlay',
  'work-dashboard: launcher',
  'work-dashboard: lifetime',
]), JSON.stringify(state.effects));

const overlayReg = state.registered.find((r) => r.options.name === 'shell.overlay' && r.options.id === 'work-dashboard');
const launcherReg = state.registered.find((r) => r.options.name === 'sidebar.footer.action' && r.options.id === 'work-dashboard-toggle');
check('overlay registration present', !!overlayReg);
check('launcher registration present', !!launcherReg);

const expectedEvents = ['api-session/status', 'api-session/added', 'api-session/removed', 'api-session/activity'];
const subscribed = state.remoteOn.map((entry) => entry.key);
check('four forwarded session events subscribed', JSON.stringify(subscribed) === JSON.stringify(expectedEvents), JSON.stringify(subscribed));
check('connection/reset subscribed twice', state.ctxOn.filter((entry) => entry.event === 'connection/reset').length === 2, String(state.ctxOn.length));
check('one interval registered (tick), no fallback poll', intervals.length === 1, String(intervals.length));

// data pipeline assertions
check('list paged with cursor across two calls', state.listRequests.length === 2
  && JSON.stringify(state.listRequests[0]) === '{}' && JSON.stringify(state.listRequests[1]) === '{"cursor":"p2"}', JSON.stringify(state.listRequests));
check('live usage read for running and usage-less sessions', state.projectionsRequests.length === 3
  && state.projectionsRequests.map((entry) => entry.sessionId).sort().join(',') === 's1,s3,s4', JSON.stringify(state.projectionsRequests));
check('account watch opened once', state.watchCalls === 1, String(state.watchCalls));
check('getBalance carries build version and locale', state.balanceCalls.length === 1
  && state.balanceCalls[0].version === '0.2.4'
  && state.balanceCalls[0].locale === 'en'
  && state.balanceCalls[0].timezoneOffsetSeconds === -new Date().getTimezoneOffset() * 60,
JSON.stringify(state.balanceCalls[0] || null));

// ---- render helpers ----
function collectText(node, out) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node === 'object' && 'type' in node) {
    if (typeof node.type === 'function') return collectText(node.type(node.props), out);
    for (const child of node.children || []) collectText(child, out);
    return out;
  }
  return out;
}

function findNode(node, predicate) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node === 'object' && 'type' in node) {
    if (typeof node.type === 'function') return findNode(node.type(node.props), predicate);
    if (predicate(node)) return node;
    for (const child of node.children || []) {
      const hit = findNode(child, predicate);
      if (hit) return hit;
    }
  }
  return null;
}

function findAll(node, predicate, out) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (typeof node === 'object' && 'type' in node) {
    if (typeof node.type === 'function') return findAll(node.type(node.props), predicate, out);
    if (predicate(node)) out.push(node);
    for (const child of node.children || []) findAll(child, predicate, out);
  }
  return out;
}

const fmt = (n) => {
  const value = Number(n) || 0;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
};

const t = plugin.apply && ((key, params) => {
  const dict = state.localeDicts.workDashboard.en;
  let text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
  if (params) for (const name of Object.keys(params)) text = text.split(`{${name}}`).join(String(params[name]));
  return text;
});

check('overlay label resolves in English', overlayReg.options.label() === 'Work dashboard', overlayReg.options.label());
check('launcher label resolves in English', launcherReg.options.label() === 'Dashboard', launcherReg.options.label());

const injected = overlayReg.options.inject();
check('overlay inject exposes view/actions/localeTag', !!injected.view && !!injected.actions && typeof injected.localeTag === 'function');
check('view snapshot functions stable', injected.view.getSnapshot === overlayReg.options.inject().view.getSnapshot);

const snapshot = injected.view.getSnapshot();
check('sessions include subagent work but drop blank rows', snapshot.sessions.state === 'ready' && snapshot.sessions.rows.length === 3
  && snapshot.sessions.rows.map((row) => row.sessionId).join(',') === 's3,s1,s4',
JSON.stringify(snapshot.sessions.rows && snapshot.sessions.rows.map((row) => row.sessionId)));
const s4Row = snapshot.sessions.rows.find((row) => row.sessionId === 's4');
check('fallback usage landed on s4', !!s4Row && !!s4Row.usage && s4Row.usage.outputTokens === 20);
check('balance ready with filtered bonus', snapshot.balance.state === 'ready' && snapshot.balance.wallets.length === 3 && snapshot.balance.bonus.length === 1, JSON.stringify(snapshot.balance));
check('account status credential-stored', snapshot.account.status === 'credential-stored' && snapshot.account.available === true);
check('updated timestamp set', snapshot.updated > 0);
check('default geometry anchored top-right', snapshot.geo.x === 1532 && snapshot.geo.y === 20 && snapshot.geo.w === 224 && snapshot.geo.h === 112, JSON.stringify(snapshot.geo));
check('visible and expanded by default', snapshot.visible === true && snapshot.collapsed === false);
check('no pin state is kept', snapshot.pinned === undefined);

// ---- render the dashboard ----
const renderProps = { t, ...overlayReg.options.inject() };
const tree = overlayReg.Component(renderProps);
const text = collectText(tree, []).join('\n');
check('header drops the title text', !findNode(tree, (node) => node.props && node.props.className === 'wdb-title'));
check('pin toggle is gone', !findNode(tree, (node) => node.props && typeof node.props['aria-label'] === 'string'
  && /Keep on top|Stop keeping on top/.test(node.props['aria-label'])));
check('close control is gone', !findNode(tree, (node) => node.props && node.props['aria-label'] === 'Close'));
const headerNode = findNode(tree, (node) => node.props && node.props.className === 'wdb-head');
const headerChildren = headerNode ? headerNode.children : [];
const headerLast = headerChildren[headerChildren.length - 1];
check('panda sits at the right end of the header', !!headerLast && headerLast.props && headerLast.props.className === 'wdb-head-icon',
  headerLast && headerLast.props ? String(headerLast.props.className) : 'no header');
check('panda is the expand/collapse toggle', !!headerLast && headerLast.props && headerLast.props['aria-label'] === 'Collapse');
if (headerLast && headerLast.props) {
  headerLast.props.onClick();
  check('clicking the header panda collapses', injected.view.getSnapshot().collapsed === true);
  injected.actions.setCollapsed(false);
}
check('panel is content-sized and pinned by its top-right corner', (() => {
  const panel = findNode(tree, (node) => node.props.role === 'complementary');
  return panel && panel.props.style.zIndex === 400 && panel.props.style.width === undefined
    && panel.props.style.height === undefined && panel.props.style.right === '20px' && panel.props.style.top === '20px';
})());
const chips = findAll(tree, (node) => node.props && node.props.className === 'wdb-chip', []);
const chipText = chips.map((chip) => collectText(chip, []).join('')).join('|');
check('elapsed chip shows seconds', chipText.includes('0s'), chipText);
check('hit-rate chip shows a percentage', chipText.includes('88%'), chipText);
const gauge = findNode(tree, (node) => node.props && node.props.role === 'img');
check('speed gauge exposes its value', gauge && gauge.props['aria-label'] === 'Speed 0.0 t/s', gauge ? gauge.props['aria-label'] : 'gauge missing');
const gaugeGradient = findNode(tree, (node) => node.type === 'linearGradient');
const gradientStops = gaugeGradient ? findAll(gaugeGradient, (node) => node.type === 'stop', []) : [];
check('gauge colour is one smooth gradient', gradientStops.length === 3
  && gradientStops.map((stop) => stop.props.className).join(',') === 'wdb-gauge-stop-high,wdb-gauge-stop-mid,wdb-gauge-stop-low',
gradientStops.map((stop) => stop.props.className).join(','));
check('gauge colours sweep with the clockwise needle', gradientStops.map((stop) => stop.props.offset).join(',') === '0%,50%,100%',
  gradientStops.map((stop) => stop.props.offset).join(','));
check('gauge arc uses the gradient', !!findNode(tree, (node) => node.props && node.props.className === 'wdb-gauge-arc'));
check('no hard-edged gauge bands remain', !findNode(tree, (node) => node.props && typeof node.props.className === 'string'
  && node.props.className.includes('wdb-gauge-band')));
const gaugeTicks = findAll(tree, (node) => node.props && typeof node.props.className === 'string'
  && node.props.className.split(' ').includes('wdb-gauge-tick'), []);
check('gauge has a two-tier 25-step scale', gaugeTicks.length === 25
  && gaugeTicks.filter((tick) => tick.props.className.includes('wdb-gauge-tick-major')).length === 5,
String(gaugeTicks.length));
// Every tick radiates from the hub: the inner endpoint sits on the r+2 circle.
// (A previous bug passed the radius as an angle, fanning every tick from one spot.)
const tickInnerRadius = (tick) => Math.hypot(Number(tick.props.x1) - 30, Number(tick.props.y1) - 32);
check('gauge ticks radiate from the hub at the inner radius',
  gaugeTicks.every((tick) => Math.abs(tickInnerRadius(tick) - 28) < 1),
  gaugeTicks.map((tick) => tickInnerRadius(tick).toFixed(2)).join(','));
// The needle must rotate about the hub and stay inside the dial at every angle:
// a mismatched CSS transform-origin once made it orbit off-center and swing out.
const needle = findNode(tree, (node) => node.props && node.props.className === 'wdb-gauge-needle');
const needleLength = needle ? Math.hypot(Number(needle.props.x2) - Number(needle.props.x1), Number(needle.props.y2) - Number(needle.props.y1)) : 0;
check('needle stays inside the dial', needleLength === 20 && needleLength < 26, String(needleLength));
const needleRotate = needle && needle.props.transform ? needle.props.transform.match(/rotate\(([-\d.]+) ([\d.]+) ([\d.]+)\)/) : null;
check('needle rests on the left end and rotates about the hub', !!needleRotate && Number(needleRotate[1]) === -30
  && Number(needleRotate[2]) === 30 && Number(needleRotate[3]) === 32,
needle ? needle.props.transform : 'needle missing');
const metricValues = findAll(tree, (node) => node.props && node.props.className === 'wdb-metric-value', []).map((node) => collectText(node, []).join(''));
check('IN/OUT/TOTAL values', metricValues[0] === fmt(12355) && metricValues[1] === fmt(698) && metricValues[2] === fmt(103223), JSON.stringify(metricValues));
const metricLabels = findAll(tree, (node) => node.props && node.props.className === 'wdb-metric-label', []).map((node) => collectText(node, []).join(''));
check('metric labels', JSON.stringify(metricLabels) === JSON.stringify(['IN', 'OUT', 'TOTAL']), JSON.stringify(metricLabels));
const amounts = findAll(tree, (node) => node.props && node.props.className === 'wdb-amt', []);
const amountText = amounts.map((node) => collectText(node, []).join(''));
check('positive balance truncates to cents', amountText.includes('12.34'), JSON.stringify(amountText));
check('sub-cent positive shows <0.01', amountText.includes('<0.01'));
check('negative balance rounds with 0.01 minimum', amountText.includes('-2.50'));
check('bonus shows its 5.00 wallet', amountText.includes('5.00'));
check('currency named once per wallet row', text.includes('CNY · Bonus'));

// A balance with nothing readable renders a dash, with the reason in the tooltip.
const originalWallets = balanceResult.value.value;
balanceResult.value.value = [];
injected.actions.refresh();
await sleep(150);
const dashNode = findNode(overlayReg.Component(renderProps), (node) => node.props && node.props.className === 'wdb-muted'
  && collectText(node, []).join('') === '-' && typeof node.props.title === 'string' && node.props.title.length > 0);
check('unreadable balance shows a dash with a reason', !!dashNode, dashNode ? dashNode.props.title : 'dash missing');
balanceResult.value.value = originalWallets;
injected.actions.refresh();
await sleep(80);
check('balance amounts are colour-coded by sign',
  amounts.some((node) => node.props['data-sign'] === 'positive')
  && amounts.some((node) => node.props['data-sign'] === 'negative')
  && !amounts.some((node) => node.props['data-sign'] === 'zero'),
  JSON.stringify(amounts.map((node) => node.props['data-sign'])));
check('session list is gone', !text.includes('Alpha'));
check('no loading placeholder while ready', !text.includes('Loading…'));

// The session LIST projection settles at checkpoint time, so a running session's
// usage there goes stale. The live per-session read must win, or every total and
// the speed needle freeze while the seconds keep ticking.
// A live read keeps winning after this point, so its value is mutable and tracks
// what each later phase wants s1 to report.
let liveS1Output = 888;
projectionsResponses.s1 = () => ({ ok: true, value: { values: { tokenUsage: { uncachedInputTokens: 999, outputTokens: liveS1Output, cacheReadTokens: 777, cacheWriteTokens: 666 } } } });
listQueue.length = 0;
listQueue.push(onePage(raised(1678)));
injected.actions.refresh();
await sleep(150);
const s1Row = (injected.view.getSnapshot().sessions.rows || []).find((row) => row.sessionId === 's1');
check('live usage overrides the stale list projection', !!s1Row && s1Row.usage.outputTokens === 888
  && s1Row.usage.uncachedInputTokens === 999, JSON.stringify(s1Row && s1Row.usage));

// CSS purity: every colour comes from a theme token, never a literal.
const styleNode = findNode(tree, (node) => node.type === 'style');
const cssText = styleNode ? styleNode.children.join('\n') : '';
check('stylesheet present', cssText.includes('.wdb-panel'));
check('css uses no literal colours',
  !/#[0-9a-fA-F]{3,8}\b/.test(cssText) && !/rgba?\(/.test(cssText) && !/hsla?\(/.test(cssText) && !/color-mix\(/.test(cssText),
  (cssText.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|color-mix\(/) || ['none']).join(','));

const panelNode = findNode(tree, (node) => node.props.role === 'complementary');
check('panel aria-label', panelNode && panelNode.props['aria-label'] === 'Work dashboard');

// ---- resize through the grip's own pointer handlers ----
const resizeHandle = findNode(tree, (node) => node.props && node.props.className === 'wdb-resize');
check('resize handle present', !!resizeHandle);
const pointer = (x, y) => ({
  pointerType: 'mouse', button: 0, pointerId: 1, clientX: x, clientY: y,
  currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
  preventDefault() {},
});
if (resizeHandle) {
  // Parked near the left edge the grip stops at the viewport edge: the size
  // clamps, the anchor never moves, so the pointer never runs away from the grip.
  injected.actions.setGeo({ w: 224, h: 112, x: 300, y: 300 });
  const edgeHandle = findNode(overlayReg.Component(renderProps), (node) => node.props && node.props.className === 'wdb-resize');
  edgeHandle.props.onPointerDown(pointer(348, 412));
  edgeHandle.props.onPointerMove(pointer(648, 612));
  const capped = injected.view.getSnapshot().geo;
  check('resize stops at the viewport edge without sliding', capped.w === 332 && capped.h === 312
    && capped.x === 300 && capped.y === 300, JSON.stringify(capped));
  edgeHandle.props.onPointerUp(pointer(648, 612));

  // Mid-screen, the grip tracks the cursor exactly in both directions.
  injected.actions.setGeo({ w: 224, h: 112, x: 500, y: 300 });
  const midTree = overlayReg.Component(renderProps);
  const midHandle = findNode(midTree, (node) => node.props && node.props.className === 'wdb-resize');
  midHandle.props.onPointerDown(pointer(548, 412));
  midHandle.props.onPointerMove(pointer(848, 612));
  const grown = injected.view.getSnapshot().geo;
  check('grip tracks the cursor while growing', grown.w === 524 && grown.h === 312 && grown.x === 500 && grown.y === 300, JSON.stringify(grown));
  midHandle.props.onPointerMove(pointer(628, 496));
  const shrunk = injected.view.getSnapshot().geo;
  check('grip tracks the cursor while shrinking', shrunk.w === 304 && shrunk.h === 196 && shrunk.x === 500 && shrunk.y === 300, JSON.stringify(shrunk));
  midHandle.props.onPointerUp(pointer(628, 496));
  injected.actions.setGeo({ w: 224, h: 112, x: 1532, y: 20 });
  injected.actions.clampGeo();
}

// ---- collapsed badge ----
injected.actions.setCollapsed(true);
const collapsedTree = overlayReg.Component(renderProps);
const badge = findNode(collapsedTree, (node) => node.props && node.props.className === 'wdb-badge');
check('collapsed renders the panda badge', !!badge && badge.props['aria-label'] === 'Expand Work dashboard', badge ? badge.props['aria-label'] : 'badge missing');
check('collapsed hides the panel body and grip', !findNode(collapsedTree, (node) => node.props.role === 'complementary')
  && !findNode(collapsedTree, (node) => node.props && node.props.className === 'wdb-resize'));
check('badge shows the speed value', collectText(badge, []).join('').includes('0.0'));
// Collapse shares the panel's top-left with the badge; it must not destroy the
// remembered panel size (clampGeo used to write the badge's size over it).
injected.actions.setGeo({ w: 420, h: 300, x: 200, y: 100 });
injected.actions.clampGeo();
const collapsedGeo = injected.view.getSnapshot().geo;
check('collapsing keeps the remembered panel size', collapsedGeo.w === 420 && collapsedGeo.h === 300, JSON.stringify(collapsedGeo));
const collapsedBadge = findNode(overlayReg.Component(renderProps), (node) => node.props && node.props.className === 'wdb-badge');
check('collapsed badge re-anchors inside the viewport', !!collapsedBadge && collapsedBadge.props.style.left === '200px' && collapsedBadge.props.style.top === '100px',
  collapsedBadge ? `${collapsedBadge.props.style.left},${collapsedBadge.props.style.top}` : 'badge missing');
injected.actions.setCollapsed(false);
injected.actions.setGeo({ w: 232, h: 124, x: 1532, y: 824 });
injected.actions.clampGeo();
if (badge) badge.props.onClick();
check('clicking the badge expands again', injected.view.getSnapshot().collapsed === false);
injected.actions.setCollapsed(true);
await sleep(400);
const collapsedPersisted = storage.get('dsh.work-dashboard.v1');
check('collapsed state persisted', !!collapsedPersisted && JSON.parse(collapsedPersisted).collapsed === true, collapsedPersisted);
injected.actions.setCollapsed(false);

injected.actions.setVisible(false);
check('hide returns null tree', overlayReg.Component(renderProps) === null);
const launcherProps = { t, ...launcherReg.options.inject() };
check('launcher reflects hidden state', findNode(launcherReg.Component(launcherProps), (node) => node.props['aria-pressed'] === false) !== null);
injected.actions.setVisible(true);
check('launcher reflects shown state', findNode(launcherReg.Component(launcherProps), (node) => node.props['aria-pressed'] === true) !== null);

// geometry clamp + corner anchoring
injected.actions.setGeo({ w: 5000, h: 5000, x: -9999, y: -50 });
injected.actions.clampGeo();
const clamped = injected.view.getSnapshot().geo;
// `geo` is the badge anchor (panel top-right); the derived panel must fit too.
const clampedPanelX = clamped.x + 48 - clamped.w;
const clampedPanelY = clamped.y;
check('clampGeo caps to viewport', clamped.w <= 1600 - 16 && clamped.h <= 900 - 16
  && clamped.x >= 0 && clamped.y >= 0 && clamped.x + 48 <= 1600 - 16 && clamped.y + 56 <= 900 - 16
  && clampedPanelX >= 0 && clampedPanelY >= 0 && clampedPanelX + clamped.w <= 1600 - 16 && clampedPanelY + clamped.h <= 900 - 16,
JSON.stringify(clamped));

injected.actions.setGeo({ w: 360, h: 240, x: 1220, y: 640 });
injected.actions.clampGeo();
window.innerWidth = 1000;
window.innerHeight = 700;
windowListeners.resize();
const followed = injected.view.getSnapshot().geo;
const followedPanelX = followed.x + 48 - followed.w;
const followedPanelY = followed.y;
check('window resize keeps the panel fully on screen', followedPanelX >= 0 && followedPanelY >= 0
  && followedPanelX + followed.w <= 1000 - 16 && followedPanelY + followed.h <= 700 - 16, JSON.stringify(followed));
check('window resize preserves the badge corner offsets', (1000 - (followed.x + 48)) === 332, JSON.stringify(followed));
window.innerWidth = 1600;
window.innerHeight = 900;
injected.actions.setGeo({ w: 360, h: 240, x: 1220, y: 640 });
injected.actions.clampGeo();

// ---- ticker: elapsed seconds, observed speed, and the running poll ----
// The clock advances on the 1s ticker, so poll briefly instead of assuming a
// fixed sleep lands after the tick that publishes the first second.
const elapsedDeadline = Date.now() + 3000;
while (injected.view.getSnapshot().elapsedSec < 1 && Date.now() < elapsedDeadline) await sleep(50);
check('elapsed seconds accumulate while a session runs', injected.view.getSnapshot().elapsedSec >= 1,
  String(injected.view.getSnapshot().elapsedSec));
check('speed starts at zero before a second sample', injected.view.getSnapshot().speed === 0, String(injected.view.getSnapshot().speed));

const beforePoll = state.listRequests.length;
// Feed a growing output so the sampler has a delta to measure, and wait for the
// ticker to publish it instead of assuming a fixed sleep clears the interval.
listQueue.length = 0;
for (let index = 0; index < 8; index += 1) listQueue.push(onePage(raised(2678)));
// The live read wins over the list, so move its value too or the sampler sees no delta.
liveS1Output = 2678;
const speedDeadline = Date.now() + 6000;
while ((state.listRequests.length <= beforePoll || injected.view.getSnapshot().speed <= 0) && Date.now() < speedDeadline) await sleep(50);
check('running work polls usage on the ticker', state.listRequests.length > beforePoll, `${beforePoll} -> ${state.listRequests.length}`);
const speedNow = injected.view.getSnapshot().speed;
check('observed output speed becomes positive', Number.isFinite(speedNow) && speedNow > 0, String(speedNow));

// A newly started parallel session must not restart the work clock.
const elapsedBefore = injected.view.getSnapshot().elapsedSec;
listQueue.length = 0;
listQueue.push(onePage([
  ...raised(1678),
  { sessionId: 's5', running: true, blank: false, updatedAt: 999999, projections: { values: { title: 'Beta' } } },
]));
const beforeEvent = state.listRequests.length;
state.remoteOn[0].listener();
await sleep(650);
check('api-session event triggers debounced refresh', state.listRequests.length > beforeEvent, `${beforeEvent} -> ${state.listRequests.length}`);
const elapsedAfter = injected.view.getSnapshot().elapsedSec;
check('a new parallel session does not reset the clock', elapsedAfter >= elapsedBefore, `${elapsedBefore} -> ${elapsedAfter}`);

// connection/reset: sessions refresh + account watch restart
listQueue.push(onePage(raised(1678)));
const beforeReset = state.listRequests.length;
for (const entry of state.ctxOn) if (entry.event === 'connection/reset') entry.listener();
await sleep(100);
check('connection/reset refreshes sessions and restarts watch', state.listRequests.length > beforeReset && state.watchCalls === 2 && state.balanceCalls.length >= 2,
`list=${state.listRequests.length} watch=${state.watchCalls} balance=${state.balanceCalls.length}`);

// manual refresh
listQueue.push(onePage(raised(1678)));
const beforeManual = state.listRequests.length;
injected.actions.refresh();
await sleep(80);
check('manual refresh re-reads sessions', state.listRequests.length > beforeManual, `${beforeManual} -> ${state.listRequests.length}`);

// persistence payload no longer carries a pin flag
await sleep(400);
const persisted = storage.get('dsh.work-dashboard.v1');
check('geometry/visibility/collapsed persisted', !!persisted, 'missing key');
if (persisted) {
  const value = JSON.parse(persisted);
  check('persisted payload shape', typeof value.geo.x === 'number' && value.visible === true
    && value.collapsed === false && value.pinned === undefined, persisted);
}

// error path: drain leftovers, then answer with failures so the queue is deterministic
listQueue.length = 0;
listQueue.push({ ok: false, error: { code: 'gateway/busy' } });
listQueue.push({ ok: false, error: { code: 'gateway/busy' } });
listQueue.push({ ok: false, error: { code: 'gateway/busy' } });
injected.actions.refresh();
await sleep(60);
const errorSnapshot = injected.view.getSnapshot();
check('remote failure surfaces error code and keeps rows', errorSnapshot.sessions.error === 'gateway/busy' && errorSnapshot.sessions.rows.length === 2,
JSON.stringify({ error: errorSnapshot.sessions.error, rows: errorSnapshot.sessions.rows.length }));
const errorText = collectText(overlayReg.Component(renderProps), []).join('\n');
check('error row renders with retry', errorText.includes('Could not load (gateway/busy)') && errorText.includes('Retry'), errorText.includes('Retry') ? 'retry ok' : 'retry missing');

// ---- refresh pipeline resilience ----
// A Remote round-trip that never settles used to hold `sessionBusy` forever, so
// every later refresh returned at the door while the local seconds kept ticking.
listQueue.length = 0;
listQueue.push(HANG);
injected.actions.refresh();
await sleep(60);
check('refresh holds the busy flag while a call is in flight', injected.view.getSnapshot().sessions.busy === true);
await sleep(420);
check('a hung Remote call releases the refresh lock', injected.view.getSnapshot().sessions.busy === false,
  JSON.stringify({ busy: injected.view.getSnapshot().sessions.busy, error: injected.view.getSnapshot().sessions.error }));
listQueue.push(onePage(raised(1678)));
const beforeRecovery = state.listRequests.length;
injected.actions.refresh();
await sleep(80);
const recovered = injected.view.getSnapshot().sessions;
check('refresh recovers after a timeout', state.listRequests.length > beforeRecovery
  && recovered.state === 'ready' && recovered.error === null, JSON.stringify(recovered));

// A hung per-session usage fallback must not block committing the list.
projectionsResponses.s6 = HANG;
listQueue.length = 0;
listQueue.push(onePage([{ sessionId: 's6', running: false, blank: false, updatedAt: 1, projections: { values: { title: 'Six' } } }]));
injected.actions.refresh();
await sleep(80);
const afterFallback = injected.view.getSnapshot();
check('a hung usage fallback does not block the list commit', afterFallback.sessions.state === 'ready'
  && afterFallback.sessions.rows.some((row) => row.sessionId === 's6'),
JSON.stringify(afterFallback.sessions.rows && afterFallback.sessions.rows.map((row) => row.sessionId)));

// With nothing running the HUD still refreshes on its own.
listQueue.length = 0;
const idlePage = () => onePage([{ sessionId: 's7', running: false, blank: false, updatedAt: 1, projections: { values: { title: 'Seven', tokenUsage: { uncachedInputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 } } } }]);
listQueue.push(idlePage());
injected.actions.refresh();
await sleep(80);
const beforeIdle = state.listRequests.length;
listQueue.push(idlePage());
await sleep(3200);
check('idle poll refreshes without a running session', state.listRequests.length > beforeIdle,
  `${beforeIdle} -> ${state.listRequests.length}`);

// Returning to the window must refresh at once: Chromium throttles the ticker
// while the page is occluded, so waiting for the next tick shows stale numbers.
listQueue.length = 0;
listQueue.push(idlePage());
const beforeFocus = state.listRequests.length;
if (typeof windowListeners.focus === 'function') windowListeners.focus();
await sleep(150);
check('window focus refreshes immediately', state.listRequests.length > beforeFocus,
  `${beforeFocus} -> ${state.listRequests.length}`);

// Stale data is announced instead of silently freezing the numbers.
listQueue.length = 0;
listQueue.push(idlePage());
injected.actions.refresh();
await sleep(60);
await sleep(220);
const staleText = collectText(overlayReg.Component(renderProps), []).join('\n');
check('stale data is called out', staleText.includes('Data may be stale'), staleText.split('\n').slice(0, 8).join(' | '));

// ---- estimated cost for non-DeepSeek models ----
// The model a session used comes from the `modelSelection` summary projection.
const mimoRow = (input, output) => ({
  sessionId: 'm1', running: true, blank: false, updatedAt: 5000,
  projections: { values: {
    title: 'Mimo',
    modelSelection: { lastUsed: { provider: 'xiaomi', model: 'mimo-v2.6-flash' }, next: null },
    tokenUsage: { uncachedInputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } },
});
const deepseekRow = {
  sessionId: 'd1', running: false, blank: false, updatedAt: 4000,
  projections: { values: {
    title: 'DeepSeek',
    modelSelection: { lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' }, next: null },
    tokenUsage: { uncachedInputTokens: 9000000, outputTokens: 9000000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } },
};
// A local Ollama session: billed nothing, so it must never enter the estimate
// nor clutter the price dialog.
const ollamaRow = {
  sessionId: 'o1', running: false, blank: false, updatedAt: 3000,
  projections: { values: {
    title: 'Local',
    modelSelection: { lastUsed: { provider: 'ollama', model: 'lfm3-omni:latest' }, next: null },
    tokenUsage: { uncachedInputTokens: 5000000, outputTokens: 5000000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } },
};
listQueue.length = 0;
listQueue.push(onePage([mimoRow(2000000, 1000000), deepseekRow, ollamaRow]));
injected.actions.refresh();
await sleep(120);
const pricedRow = (injected.view.getSnapshot().sessions.rows || []).find((row) => row.sessionId === 'm1');
check('session row carries provider and model', !!pricedRow && pricedRow.provider === 'xiaomi'
  && pricedRow.model === 'mimo-v2.6-flash', JSON.stringify(pricedRow && { provider: pricedRow.provider, model: pricedRow.model }));
check('MiMo is priced by the built-in list, DeepSeek and Ollama are skipped',
  injected.view.getSnapshot().cost.unpriced === 0 && injected.view.getSnapshot().cost.priced === 1,
  JSON.stringify(injected.view.getSnapshot().cost));

// Growth since first sight is what gets priced.
listQueue.push(onePage([mimoRow(3000000, 1500000), deepseekRow, ollamaRow]));
injected.actions.refresh();
await sleep(120);
const defaultCost = injected.view.getSnapshot().cost;
check('built-in list prices estimate the token delta', defaultCost.priced === 1 && defaultCost.unpriced === 0
  && defaultCost.total === 2, JSON.stringify(defaultCost));
const defaultCostText = collectText(overlayReg.Component(renderProps), []).join('\n');
check('estimated cost renders out of the box', defaultCostText.includes('≈¥2.00'), defaultCostText.slice(0, 200));

// Enter prices through the ¥ dialog; the fields arrive prefilled with the list price.
const yenButton = findNode(overlayReg.Component(renderProps), (node) => node.props
  && node.props['aria-label'] === 'Unit prices per 1M tokens');
check('price dialog has an entry point', !!yenButton);
yenButton.props.onClick();
const editorTree = overlayReg.Component(renderProps);
check('dialog lists the priced model', !!findNode(editorTree, (node) => node.props
  && node.props.className === 'wdb-price-name' && collectText(node, []).join('') === 'xiaomi/mimo-v2.6-flash'));
check('dialog keeps DeepSeek and Ollama out', !findNode(editorTree, (node) => node.props
  && node.props.className === 'wdb-price-name'
  && /deepseek|ollama/.test(collectText(node, []).join(''))));
const priceInputs = findAll(editorTree, (node) => node.type === 'input', []);
check('dialog prefills the built-in prices', priceInputs.map((input) => input.props.value).join(',') === '1,2,0.02,1',
  priceInputs.map((input) => input.props.value).join(','));
// A user override replaces the list price.
priceInputs[0].props.onChange({ target: { value: '3' } });
priceInputs[1].props.onChange({ target: { value: '4' } });
findNode(overlayReg.Component(renderProps), (node) => node.props && node.props.className === 'wdb-btn'
  && collectText(node, []).join('') === 'Save').props.onClick();
await sleep(50);
const costSnap = injected.view.getSnapshot();
check('saving prices persists them', (storage.get('dsh.work-dashboard.prices.v1') || '').includes('mimo-v2.6-flash'),
  storage.get('dsh.work-dashboard.prices.v1'));
check('cost is estimated from the token delta and the overridden price', costSnap.priceOpen === false
  && costSnap.cost.priced === 1 && costSnap.cost.unpriced === 0 && costSnap.cost.total === 5,
JSON.stringify(costSnap.cost));
const costText = collectText(overlayReg.Component(renderProps), []).join('\n');
check('overridden cost renders with an approximation mark', costText.includes('≈¥5.00'), costText.slice(0, 200));

// teardown
let teardownClean = true;
for (const { label, dispose } of state.cleanups) {
  try {
    if (typeof dispose === 'function') dispose();
  } catch (error) {
    teardownClean = false;
    console.log(`FAIL cleanup ${label}: ${error && error.message}`);
  }
}
check('all effect cleanups run without throwing', teardownClean);
globalThis.setInterval = realSetInterval;

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const failure of failures) console.log(` - ${failure}`);
  process.exit(1);
}
