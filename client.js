window.__ModuleLoader__.load({
  id: '@local/work-dashboard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'workDashboard';
    const LS_KEY = 'dsh.work-dashboard.v1';
    // Runtime diagnostics, readable from outside the app (Electron's LevelDB):
    // shows whether the refresh loop runs at all and what it sees.
    const DIAG_KEY = 'dsh.work-dashboard.diag';
    // Unit prices the user types in: { 'provider/model': { input, output, cacheRead, cacheWrite } }
    // in currency units per 1,000,000 tokens. The client cannot fetch prices (sandboxed
    // renderer, no web-fetch remote), so they are entered once and kept locally.
    const PRICE_KEY = 'dsh.work-dashboard.prices.v1';
    // The DeepSeek platform account has a real balance; those sessions are priced by it.
    const DEEPSEEK_PROVIDER = 'deepseek-account';
    // Local models run on this machine and bill nothing: no estimate, no price row.
    const UNMETERED_PROVIDERS = new Set(['ollama']);
    // List prices in CNY per 1,000,000 tokens, filled in until the user overrides
    // them in the ¥ dialog. Source: mimo.mi.com pay-as-you-go page (real-time
    // tier, 2026-11). Cache writes are billed at the cache-miss input rate.
    const DEFAULT_PRICES = {
      'xiaomi/mimo-v2.6-flash': { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1 },
      'xiaomi/mimo-v2.6-pro': { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3 },
      'xiaomi/mimo-v2.6-pro-ultraspeed': { input: 30, output: 60, cacheRead: 0.25, cacheWrite: 30 },
    };
    const BUILD_VERSION = '0.2.3';
    const MIN_W = 216;
    const MIN_H = 84;
    const MAX_MARGIN = 16;
    const DEFAULT_W = 224;
    const DEFAULT_H = 112;
    const BADGE_W = 48;
    const BADGE_H = 56;
    // Below the host's menus (~1100) and popovers (~1200-1250): transient host UI
    // may cover the HUD, which still rides the frame-wide overlay above every
    // column. There is no pin toggle; this value is fixed.
    const Z_INDEX = 400;
    const TICK_MS = 1000;
    const SAMPLE_WINDOW_MS = 10000;
    const SAMPLE_MAX = 8;
    const FALLBACK_USAGE_ROWS = 12;
    const FALLBACK_USAGE_CHUNK = 4;
    const EVENT_REFRESH_DEBOUNCE_MS = 500;
    const PERSIST_DEBOUNCE_MS = 300;
    const FALLBACK_POLL_MS = 30000;
    const POLL_MS = 2000;
    // A single Remote round-trip may hang while the Host rebuilds projections for
    // a large session log. Without an upper bound that await never settles, the
    // refresh lock never releases, and every later refresh returns at the door —
    // the HUD then freezes while the locally computed seconds keep ticking.
    // `window.__WDB_TIMING__` shortens these for tests only.
    const TIMING = {
      refresh: 8000,
      idle: 5000,
      stale: 15000,
      ...(typeof window !== 'undefined' && window.__WDB_TIMING__ ? window.__WDB_TIMING__ : {}),
    };
    const REFRESH_TIMEOUT_MS = TIMING.refresh;
    const IDLE_POLL_MS = TIMING.idle;
    const STALE_MS = TIMING.stale;
    const GAUGE_MAX = 100;

    const en = {
      title: 'Work dashboard',
      launcher: 'Dashboard',
      collapse: 'Collapse',
      expand: 'Expand',
      balance: 'Balance',
      bonus: 'Bonus',
      loading: 'Loading…',
      failed: 'Could not load',
      retry: 'Retry',
      refresh: 'Refresh',
      updated: 'Updated {time}',
      signedOut: 'Not signed in',
      unavailable: 'Unavailable',
      noUsage: 'No usage data',
      stale: 'Data may be stale',
      input: 'IN',
      output: 'OUT',
      total: 'TOTAL',
      seconds: '{count}s',
      speedUnit: 't/s',
      hitRate: 'Cache hit',
      speedLabel: 'Speed',
      cost: 'Est.',
      pricesTitle: 'Unit prices per 1M tokens',
      priceInput: 'IN',
      priceOutput: 'OUT',
      priceCacheRead: 'CR',
      priceCacheWrite: 'CW',
      save: 'Save',
      cancel: 'Cancel',
      noModels: 'No models yet',
      unpriced: '{count} models without prices',
    };
    const zh = {
      title: '工作仪表盘',
      launcher: '仪表盘',
      collapse: '收起',
      expand: '展开',
      balance: '余额',
      bonus: '奖励金',
      loading: '加载中…',
      failed: '加载失败',
      retry: '重试',
      refresh: '刷新',
      updated: '更新于 {time}',
      signedOut: '未登录',
      unavailable: '不可用',
      noUsage: '暂无用量数据',
      stale: '数据可能已过期',
      input: 'IN',
      output: 'OUT',
      total: 'TOTAL',
      seconds: '{count}秒',
      speedUnit: 't/s',
      hitRate: '命中率',
      speedLabel: '速度',
      cost: '估算',
      pricesTitle: '单价（每百万 token）',
      priceInput: '输入',
      priceOutput: '输出',
      priceCacheRead: '缓存读',
      priceCacheWrite: '缓存写',
      save: '保存',
      cancel: '取消',
      noModels: '暂无模型',
      unpriced: '{count} 个模型未填单价',
    };

    // Gauge geometry: a 240° speedometer sweep with the gap at the bottom, so
    // the dial is taller than it is wide. Angles are math-style (0° = right,
    // 90° = up); the needle sweeps START → START-SWEEP.
    const gauge = (() => {
      const cx = 30;
      const cy = 32;
      const r = 26;
      const START = 210;
      const SWEEP = 240;
      const rad = (angleDeg) => (angleDeg * Math.PI) / 180;
      const at = (angleDeg, radius) => ({ x: cx + radius * Math.cos(rad(angleDeg)), y: cy - radius * Math.sin(rad(angleDeg)) });
      const point = (angleDeg) => at(angleDeg, r);
      // Large-arc flag 1: the sweep is 240° (> 180°) and passes over the top.
      const arc = `M ${point(START).x.toFixed(2)} ${point(START).y.toFixed(2)} A ${r} ${r} 0 1 1 ${point(START - SWEEP).x.toFixed(2)} ${point(START - SWEEP).y.toFixed(2)}`;
      // A tick every 10°, with a longer one every 60°: a readable two-tier scale
      // instead of nine sparse marks.
      const TICK_COUNT = 25;
      const ticks = Array.from({ length: TICK_COUNT }, (_, index) => {
        const angle = START - (SWEEP / (TICK_COUNT - 1)) * index;
        const major = index % 6 === 0;
        // Both endpoints sit on the tick's own ray (a previous version passed
        // the radius as an angle, fanning every tick from one spot).
        const inner = at(angle, r + 2);
        const outer = at(angle, r + (major ? 6 : 4));
        return {
          x1: inner.x.toFixed(2),
          y1: inner.y.toFixed(2),
          x2: outer.x.toFixed(2),
          y2: outer.y.toFixed(2),
          major,
        };
      });
      return { cx, cy, startAngle: START, sweep: SWEEP, arc, ticks };
    })();

    const CSS = `
.wdb-panel{position:fixed;display:flex;flex-direction:column;min-width:${MIN_W}px;min-height:${MIN_H}px;box-sizing:border-box;background:var(--dsw-alias-bg-overlay);border:var(--dsh-hairline-width,.5px) solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl,14px);box-shadow:var(--dsw-elevation-panel,none);color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;overflow:hidden;container-type:inline-size}
.wdb-head{display:flex;align-items:center;gap:4px;padding:3px 7px;border-bottom:var(--dsh-hairline-width,.5px) solid var(--dsw-alias-border-l1);cursor:move;touch-action:none;user-select:none;-webkit-user-select:none;flex:none}
.wdb-head-icon{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:20px;height:20px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;flex:none}
.wdb-head-icon:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.wdb-chips{display:flex;align-items:center;gap:4px;flex:1;min-width:0}
.wdb-chip{display:inline-flex;align-items:center;gap:3px;font-size:9px;line-height:12px;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.wdb-chip[data-active="true"]{color:var(--dsw-alias-brand-primary)}
.wdb-chip-icon{display:flex;color:currentColor}
.wdb-head-icon:focus-visible,.wdb-btn:focus-visible,.wdb-launcher:focus-visible,.wdb-badge:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.wdb-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto;overscroll-behavior:contain}
.wdb-hero{display:grid;grid-template-columns:60px max-content 1fr auto;column-gap:4px;align-items:center;padding:5px 7px;flex:none}
.wdb-gauge{position:relative;width:60px;height:48px;flex:none}
.wdb-gauge-svg{display:block;width:60px;height:48px;overflow:visible}
.wdb-gauge-arc{stroke:url(#wdb-gauge-grad);stroke-width:4;fill:none;stroke-linecap:round}
.wdb-gauge-stop-low{stop-color:var(--dsw-alias-state-error-primary)}
.wdb-gauge-stop-mid{stop-color:var(--dsw-alias-state-warn-primary)}
.wdb-gauge-stop-high{stop-color:var(--dsw-alias-state-success-primary)}
.wdb-gauge-tick{stroke:var(--dsw-alias-border-l2);stroke-width:1}
.wdb-gauge-tick-major{stroke:var(--dsw-alias-label-tertiary);stroke-width:1.2}
.wdb-gauge-needle{stroke:var(--dsw-alias-brand-primary);stroke-width:2;stroke-linecap:round;transition:transform .45s ease-out}
.wdb-gauge-hub{fill:var(--dsw-alias-brand-primary)}
.wdb-gauge-value{position:absolute;left:0;right:0;top:12px;text-align:center;font-size:13px;line-height:17px;font-weight:600;font-variant-numeric:tabular-nums}
.wdb-gauge-unit{position:absolute;left:0;right:0;top:28px;text-align:center;font-size:8px;line-height:11px;color:var(--dsw-alias-label-secondary)}
.wdb-metrics{display:flex;flex-direction:column;gap:2px;min-width:0}
.wdb-metric{display:flex;align-items:baseline;justify-content:space-between;gap:4px;min-height:14px}
.wdb-metric-label{font-size:9px;line-height:12px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;flex:none}
.wdb-metric-value{font-size:11px;line-height:14px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wdb-metric-total{border-top:var(--dsh-hairline-width,.5px) solid var(--dsw-alias-border-l1);padding-top:2px;margin-top:1px}
.wdb-metric-total .wdb-metric-value{font-size:12px;line-height:18px;font-weight:600}
.wdb-balance{display:flex;flex-direction:column;gap:1px;min-width:0}
.wdb-balance-label{font-size:9px;line-height:12px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.wdb-wallet{display:flex;align-items:baseline;justify-content:space-between;gap:4px;min-height:14px}
.wdb-wallet-label{font-size:9px;line-height:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.wdb-amt{font-size:11px;line-height:14px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.wdb-amt[data-sign="negative"]{color:var(--dsw-alias-state-error-primary)}
.wdb-status-line{padding:0 7px 4px;font-size:9px;line-height:12px;color:var(--dsw-alias-label-secondary)}
.wdb-inline-error{padding:0 7px 4px;font-size:9px;line-height:12px;color:var(--dsw-alias-state-error-primary);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wdb-muted{color:var(--dsw-alias-label-secondary);font-size:9px;line-height:12px}
.wdb-btn{box-sizing:border-box;border:var(--dsh-hairline-width,.5px) solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:9px;line-height:13px;height:20px;padding:0 7px;flex:none}
.wdb-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.wdb-resize{position:absolute;right:2px;bottom:2px;width:11px;height:11px;cursor:nwse-resize;touch-action:none;border-radius:0 0 var(--dsw-radius-xl,14px) 0;opacity:.5;transition:opacity .12s;background-image:radial-gradient(var(--dsw-alias-border-l2) 1px,transparent 1.2px);background-size:5px 5px;background-position:2px 2px}
.wdb-resize:hover{opacity:1}
.wdb-badge{position:fixed;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;padding:4px 0;border:var(--dsh-hairline-width,.5px) solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl,14px);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-panel,none);color:var(--dsw-alias-label-primary);cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}
.wdb-badge:hover{background:var(--dsw-alias-bg-layer-1)}
.wdb-badge-icon{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);flex:none}
.wdb-badge-value{font-size:10px;line-height:14px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.wdb-launcher{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:7px 10px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:13px;line-height:20px;text-align:left}
.wdb-launcher:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1))}
.wdb-launcher[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary)}
.wdb-launcher-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wdb-prices{display:flex;flex-direction:column;gap:6px;padding:8px;overflow:auto;min-height:0}
.wdb-prices-title{font-size:9px;line-height:12px;color:var(--dsw-alias-label-secondary)}
.wdb-price-row{display:flex;flex-direction:column;gap:3px;border-top:var(--dsh-hairline-width,.5px) solid var(--dsw-alias-border-l1);padding-top:5px}
.wdb-price-name{font-size:10px;line-height:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wdb-price-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.wdb-price-field{display:flex;align-items:center;gap:4px;font-size:9px;line-height:12px;color:var(--dsw-alias-label-secondary)}
.wdb-price-field span{flex:none;width:30px}
.wdb-price-field input{box-sizing:border-box;width:100%;min-width:0;height:18px;padding:0 4px;font:inherit;font-size:10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:var(--dsh-hairline-width,.5px) solid var(--dsw-alias-border-l1);border-radius:4px}
.wdb-prices-actions{display:flex;gap:6px;justify-content:flex-end;padding-top:2px}
@media (prefers-reduced-motion: reduce){.wdb-gauge-needle{transition:none}.wdb-resize{transition:none}}
`;

    function group(intText) {
      return String(intText).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /**
     * Balance display: two decimals grouped, positive truncates to cents, sub-cent
     * positive shows <0.01, negative rounds with a 0.01 minimum magnitude. The
     * wallet row already names the currency.
     */
    function formatAmount(raw) {
      const text = String(raw == null ? '' : raw).trim();
      if (!text) return '0.00';
      const negative = text.startsWith('-');
      const body = negative ? text.slice(1) : text;
      const match = /^(\d*)(?:\.(\d*))?$/.exec(body);
      if (!match) return text;
      const intPart = match[1] || '0';
      const frac = match[2] || '';
      const magnitude = Number(`${intPart}.${frac || '0'}`) || 0;
      if (!negative) {
        if (magnitude === 0) return '0.00';
        if (magnitude < 0.01) return '<0.01';
        const cents = frac.slice(0, 2).padEnd(2, '0');
        return `${group(intPart)}.${cents}`;
      }
      const rounded = Math.round(magnitude * 100) / 100;
      const shown = rounded < 0.01 ? '0.01' : rounded.toFixed(2);
      const parts = shown.split('.');
      return `-${group(parts[0])}.${parts[1]}`;
    }

    /** Colour key for a balance: across currencies only the sign is meaningful. */
    function signOf(raw) {
      const value = Number(String(raw == null ? '' : raw).trim());
      if (!Number.isFinite(value)) return 'unknown';
      return value > 0 ? 'positive' : value < 0 ? 'negative' : 'zero';
    }

    function formatTokens(n) {
      const value = Number(n) || 0;
      if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
      if (value >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
      return String(value);
    }

    function clock(tag, ts) {
      const date = new Date(ts);
      try {
        return date.toLocaleTimeString(tag || undefined, { hour: '2-digit', minute: '2-digit' });
      } catch (_error) {
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      }
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    /** Fit the expanded panel to the viewport: size first, then a fully on-screen position. */
    function fitGeo(geo) {
      const w = clamp(geo.w, MIN_W, Math.max(MIN_W, window.innerWidth - MAX_MARGIN));
      const hgt = clamp(geo.h, MIN_H, Math.max(MIN_H, window.innerHeight - MAX_MARGIN));
      return {
        w,
        h: hgt,
        x: clamp(geo.x, 0, Math.max(0, window.innerWidth - MAX_MARGIN - w)),
        y: clamp(geo.y, 0, Math.max(0, window.innerHeight - MAX_MARGIN - hgt)),
      };
    }

    /** Fit the collapsed badge's top-left to the viewport. The badge's size is fixed; `geo` keeps the panel's own width/height, so collapsing must never overwrite them. */
    function fitBadge(geo) {
      return {
        x: clamp(geo.x, 0, Math.max(0, window.innerWidth - MAX_MARGIN - BADGE_W)),
        y: clamp(geo.y, 0, Math.max(0, window.innerHeight - MAX_MARGIN - BADGE_H)),
      };
    }

    /**
     * The panel's on-screen rect derived from the badge anchor stored in `geo`.
     * The badge marks the panel's TOP-RIGHT corner: expanding opens down-left
     * from the badge, and the avatar itself never moves.
     */
    function panelRect(geo) {
      return { x: geo.x + BADGE_W - geo.w, y: geo.y, w: geo.w, h: geo.h };
    }

    /** The badge anchor for a panel rect (its top-right corner). */
    function anchorOf(rect) {
      return { x: rect.x + rect.w - BADGE_W, y: rect.y };
    }

    function PandaIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true',
        style: { display: 'block', flex: 'none' },
      },
        h('circle', { cx: 6.4, cy: 6.2, r: 2.9, fill: 'currentColor' }),
        h('circle', { cx: 17.6, cy: 6.2, r: 2.9, fill: 'currentColor' }),
        h('circle', { cx: 12, cy: 13.2, r: 8.2, fill: 'currentColor', opacity: 0.14 }),
        h('ellipse', { cx: 9, cy: 11.6, rx: 2.1, ry: 2.7, fill: 'currentColor', transform: 'rotate(-16 9 11.6)' }),
        h('ellipse', { cx: 15, cy: 11.6, rx: 2.1, ry: 2.7, fill: 'currentColor', transform: 'rotate(16 15 11.6)' }),
        h('circle', { cx: 9.1, cy: 11.2, r: 0.85, fill: 'var(--dsw-alias-bg-overlay)' }),
        h('circle', { cx: 14.9, cy: 11.2, r: 0.85, fill: 'var(--dsw-alias-bg-overlay)' }),
        h('ellipse', { cx: 12, cy: 15.2, rx: 1.45, ry: 1.05, fill: 'currentColor' }),
        h('path', { d: 'M10.5 17.1c.8.8 2.2.8 3 0', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', fill: 'none' })
      );
    }

    function ClockIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 10, height: 10, 'aria-hidden': 'true',
        fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
        style: { display: 'block' },
      }, h('circle', { cx: 12, cy: 12, r: 8 }), h('path', { d: 'M12 7.5V12l3 1.8' }));
    }

    function PercentIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 10, height: 10, 'aria-hidden': 'true',
        fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
        style: { display: 'block' },
      }, h('path', { d: 'M6.5 17.5l11-11' }), h('circle', { cx: 7.5, cy: 7.5, r: 2.2 }), h('circle', { cx: 16.5, cy: 16.5, r: 2.2 }));
    }

    function SpeedGauge(props) {
      const speed = Number(props.speed) || 0;
      const ratio = clamp(speed / GAUGE_MAX, 0, 1);
      return h('div', {
        className: 'wdb-gauge',
        role: 'img',
        'aria-label': `${props.label} ${speed.toFixed(1)} ${props.unit}`,
      },
        h('svg', { className: 'wdb-gauge-svg', viewBox: '0 0 60 48', 'aria-hidden': 'true' },
          h('defs', null,
            h('linearGradient', { id: 'wdb-gauge-grad', x1: '0', y1: '0', x2: '1', y2: '0' },
              // Flipped to follow the clockwise sweep: the needle rests on the
              // calm end (left) and runs into the red zone at the top end.
              h('stop', { offset: '0%', className: 'wdb-gauge-stop-high' }),
              h('stop', { offset: '50%', className: 'wdb-gauge-stop-mid' }),
              h('stop', { offset: '100%', className: 'wdb-gauge-stop-low' })
            )
          ),
          h('path', { className: 'wdb-gauge-arc', d: gauge.arc }),
          gauge.ticks.map((tick, index) => h('line', {
            key: `t-${index}`,
            className: tick.major ? 'wdb-gauge-tick wdb-gauge-tick-major' : 'wdb-gauge-tick',
            x1: tick.x1, y1: tick.y1, x2: tick.x2, y2: tick.y2,
          })),
          h('line', {
            className: 'wdb-gauge-needle',
            x1: gauge.cx, y1: gauge.cy,
            x2: gauge.cx - 20, y2: gauge.cy,
            // SVG rotate is clockwise-on-screen, while `at()` uses math angles
            // (y up), so the attribute angle is 180° - math angle. This makes the
            // needle rest on the arc's left end and sweep clockwise to the right
            // end, exactly over the drawn arc.
            transform: `rotate(${(180 - (gauge.startAngle - gauge.sweep * ratio)).toFixed(2)} ${gauge.cx} ${gauge.cy})`,
          }),
          h('circle', { className: 'wdb-gauge-hub', cx: gauge.cx, cy: gauge.cy, r: 2.4 })
        ),
        h('span', { className: 'wdb-gauge-value' }, speed.toFixed(1)),
        h('span', { className: 'wdb-gauge-unit' }, props.unit)
      );
    }

    function MetricRow(props) {
      return h('div', { className: props.total ? 'wdb-metric wdb-metric-total' : 'wdb-metric' },
        h('span', { className: 'wdb-metric-label' }, props.label),
        h('span', { className: 'wdb-metric-value', title: props.title }, props.value)
      );
    }

    function WalletRow(props) {
      const wallet = props.wallet;
      const extra = props.extra;
      const label = wallet.currency + (extra ? ` · ${extra}` : '');
      return h('div', { className: 'wdb-wallet' },
        h('span', { className: 'wdb-wallet-label' }, label),
        h('span', { className: 'wdb-amt', 'data-sign': signOf(wallet.balance) }, formatAmount(wallet.balance))
      );
    }

    function createStore(initial) {
      let state = initial;
      const subs = new Set();
      return {
        subscribe(fn) {
          subs.add(fn);
          return () => {
            subs.delete(fn);
          };
        },
        getSnapshot() {
          return state;
        },
        patch(next) {
          state = { ...state, ...next };
          for (const fn of subs) fn();
        },
      };
    }

    function loadPersisted() {
      try {
        const raw = window.localStorage.getItem(LS_KEY);
        if (!raw) return null;
        const value = JSON.parse(raw);
        return value && typeof value === 'object' ? value : null;
      } catch (_error) {
        return null;
      }
    }

    /** Built-in list prices plus the user's edits (`provider/model` keys); edits win. */
    function loadPrices() {
      let stored = {};
      try {
        const raw = window.localStorage.getItem(PRICE_KEY);
        const value = raw ? JSON.parse(raw) : null;
        if (value && typeof value === 'object') stored = value;
      } catch (_error) {}
      return { ...DEFAULT_PRICES, ...stored };
    }

    function savePrices(prices) {
      try {
        window.localStorage.setItem(PRICE_KEY, JSON.stringify(prices));
      } catch (_error) {}
    }

    function defaultGeo() {
      const w = Math.min(DEFAULT_W, Math.max(MIN_W, window.innerWidth - 32));
      const hgt = Math.min(DEFAULT_H, Math.max(MIN_H, window.innerHeight - 32));
      // The badge anchors the HUD's top-right corner; the panel opens down-left,
      // so the default parking spot is the screen's top-right (a bottom park
      // would push the downward-opening panel off screen).
      return { w, h: hgt, x: window.innerWidth - BADGE_W - 20, y: 20 };
    }

    /** Totals over every known session; the HUD describes the plugin's whole view. */
    function sumUsage(rows) {
      const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, known: 0, missing: 0, hit: null, total: 0 };
      for (const row of rows) {
        const usage = row.usage;
        if (!usage) {
          totals.missing += 1;
          continue;
        }
        totals.known += 1;
        totals.input += Number(usage.uncachedInputTokens) || 0;
        totals.output += Number(usage.outputTokens) || 0;
        totals.cacheRead += Number(usage.cacheReadTokens) || 0;
        totals.cacheWrite += Number(usage.cacheWriteTokens) || 0;
      }
      const denom = totals.input + totals.cacheRead + totals.cacheWrite;
      totals.hit = denom > 0 ? Math.round((totals.cacheRead / denom) * 100) : null;
      totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
      return totals;
    }

    function Dashboard(props) {
      const t = props.t || ((key) => key);
      const view = props.view;
      const actions = props.actions;
      const snap = React.useSyncExternalStore(view.subscribe, view.getSnapshot);
      const geo = snap.geo;
      const dragRef = React.useRef(null);
      const resizeRef = React.useRef(null);
      const badgeRef = React.useRef(null);
      const panelRef = React.useRef(null);

      if (!snap.visible) return null;

      const tag = props.localeTag ? props.localeTag() : undefined;
      const rows = snap.sessions.rows || [];
      const totals = sumUsage(rows);
      const speed = Number(snap.speed) || 0;
      const elapsed = Number(snap.elapsedSec) || 0;
      const hitRate = totals.hit;
      // `geo` holds the badge anchor; the panel is always derived from it.
      const rect = fitGeo(panelRect(geo));

      const onHeadDown = (event) => {
        if (event.target && typeof event.target.closest === 'function' && event.target.closest('button')) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch (_error) {}
        dragRef.current = { px: event.clientX, py: event.clientY, anchor: { x: geo.x, y: geo.y } };
        event.preventDefault();
      };
      const onHeadMove = (event) => {
        const drag = dragRef.current;
        if (!drag) return;
        // The stored anchor IS the badge corner, so moving it by the pointer
        // delta is exact whatever the panel's content-driven size is.
        const next = fitBadge({ x: drag.anchor.x + (event.clientX - drag.px), y: drag.anchor.y + (event.clientY - drag.py) });
        actions.setGeo({ x: next.x, y: next.y });
      };
      const onHeadUp = (event) => {
        if (!dragRef.current) return;
        dragRef.current = null;
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch (_error) {}
        actions.persistGeo();
      };

      const onResizeDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch (_error) {}
        // Adopt the content-driven size before the first drag so the grip starts
        // from what is actually on screen rather than the stored default.
        const node = panelRef.current;
        const w = snap.sized ? geo.w : ((node && node.offsetWidth) || geo.w);
        const h = snap.sized ? geo.h : ((node && node.offsetHeight) || geo.h);
        resizeRef.current = { px: event.clientX, py: event.clientY, w, h };
        actions.markSized();
        if (!snap.sized) actions.setGeo({ w, h });
        event.preventDefault();
      };
      const onResizeMove = (event) => {
        const start = resizeRef.current;
        if (!start) return;
        // The grip is the panel's bottom-right corner; the top-right edge stays
        // pinned, so a drag only changes width to the left and height downward.
        const maxW = Math.max(MIN_W, geo.x + BADGE_W - MAX_MARGIN);
        const maxH = Math.max(MIN_H, window.innerHeight - MAX_MARGIN - geo.y);
        actions.setGeo({
          w: clamp(start.w + (event.clientX - start.px), MIN_W, maxW),
          h: clamp(start.h + (event.clientY - start.py), MIN_H, maxH),
        });
      };
      const onResizeUp = (event) => {
        if (!resizeRef.current) return;
        resizeRef.current = null;
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch (_error) {}
        actions.persistGeo();
      };

      const badge = (() => {
        if (!snap.collapsed) return null;
        const place = fitBadge(geo);
        return h('button', {
          type: 'button',
          className: 'wdb-badge',
          'aria-label': `${t('expand')} ${t('title')}`,
          title: t('title'),
          style: {
            left: `${place.x}px`,
            top: `${place.y}px`,
            width: `${BADGE_W}px`,
            height: `${BADGE_H}px`,
            zIndex: Z_INDEX,
          },
          onClick: () => actions.setCollapsed(false),
          onPointerDown: (event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch (_error) {}
            badgeRef.current = { px: event.clientX, py: event.clientY, x: place.x, y: place.y, moved: false };
          },
          onPointerMove: (event) => {
            const drag = badgeRef.current;
            if (!drag) return;
            const dx = event.clientX - drag.px;
            const dy = event.clientY - drag.py;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
            if (!drag.moved) return;
            const next = fitBadge({ x: drag.x + dx, y: drag.y + dy });
            actions.setGeo({ x: next.x, y: next.y });
          },
          onPointerUp: (event) => {
            const drag = badgeRef.current;
            if (!drag) return;
            badgeRef.current = null;
            try {
              event.currentTarget.releasePointerCapture(event.pointerId);
            } catch (_error) {}
            if (drag.moved) actions.persistGeo();
          },
          onPointerCancel: () => {
            badgeRef.current = null;
          },
        },
          h('span', { className: 'wdb-badge-icon' }, h(PandaIcon, { size: 20 })),
          h('span', { className: 'wdb-badge-value' }, speed.toFixed(1))
        );
      })();

      const statusLine = (() => {
        if (snap.sessions.error) {
          return h('div', { className: 'wdb-inline-error' },
            h('span', null, `${t('failed')}${snap.sessions.error ? ` (${snap.sessions.error})` : ''}`),
            h('button', { type: 'button', className: 'wdb-btn', onClick: () => actions.refresh() }, t('retry'))
          );
        }
        if (snap.sessions.state !== 'ready') {
          return h('div', { className: 'wdb-status-line' }, t('loading'));
        }
        if (totals.known === 0) {
          return h('div', { className: 'wdb-status-line' }, t('noUsage'));
        }
        // A stalled refresh now surfaces instead of leaving stale numbers silently
        // on screen; the idle poll usually clears it within a few seconds.
        if (snap.lastOkAt > 0 && Date.now() - snap.lastOkAt > STALE_MS) {
          return h('div', { className: 'wdb-status-line' }, t('stale'));
        }
        return null;
      })();

      const balanceBody = (() => {
        const account = snap.account;
        const balance = snap.balance;
        // Nothing readable to show: a dash keeps the column from jumping, and the
        // reason lives in the tooltip instead of a long label.
        const dash = (reason) => h('span', { className: 'wdb-muted', title: reason }, '-');
        if (account.available === false || account.status === 'failed') return dash(t('unavailable'));
        if (account.status === 'signed-out') return dash(t('signedOut'));
        if (!account.status) return dash(t('loading'));
        if (balance.state === 'failed') return dash(t('failed'));
        if (balance.state === 'unavailable') return dash(t('unavailable'));
        // Show the last known amounts while a re-read is in flight instead of
        // flashing a dash.
        if (balance.state === 'ready' || (balance.state === 'loading' && balance.wallets.length > 0)) {
          return h(React.Fragment, null,
            balance.wallets.length === 0
              ? dash(t('unavailable'))
              : balance.wallets.map((wallet, index) => h(WalletRow, { key: `w-${index}`, wallet, extra: null })),
            balance.bonus.map((wallet, index) => h(WalletRow, { key: `b-${index}`, wallet, extra: t('bonus') }))
          );
        }
        return dash(t('loading'));
      })();

      const hitText = hitRate === null ? '—' : `${hitRate}%`;

      // Models actually seen in the fleet, so the price editor lists only what the
      // user needs to fill in. DeepSeek is covered by the real balance and local
      // models bill nothing, so neither belongs in the editor.
      const models = (() => {
        const seen = new Map();
        for (const row of rows) {
          if (!row.provider || !row.model) continue;
          if (row.provider === DEEPSEEK_PROVIDER || UNMETERED_PROVIDERS.has(row.provider)) continue;
          const key = `${row.provider}/${row.model}`;
          if (!seen.has(key)) seen.set(key, key);
        }
        return [...seen.values()];
      })();

      const costRow = (snap.cost.priced > 0 || snap.cost.unpriced > 0)
        ? h('div', { className: 'wdb-wallet' },
            h('span', { className: 'wdb-wallet-label' }, t('cost')),
            h('span', {
              className: 'wdb-amt',
              title: snap.cost.unpriced > 0 ? t('unpriced', { count: snap.cost.unpriced }) : '',
            }, snap.cost.priced > 0 ? `≈¥${snap.cost.total.toFixed(2)}` : '-'))
        : null;

      const priceEditor = h('div', { className: 'wdb-prices' },
        h('div', { className: 'wdb-prices-title' }, t('pricesTitle')),
        models.length === 0
          ? h('div', { className: 'wdb-muted' }, t('noModels'))
          : models.map((key) => {
            const price = snap.prices[key] || {};
            const field = (name, label) => h('label', { className: 'wdb-price-field', key: name },
              h('span', null, label),
              h('input', {
                type: 'number',
                min: '0',
                step: '0.01',
                value: price[name] === undefined ? '' : String(price[name]),
                onChange: (event) => actions.setPrice(key, name, event.target.value),
              })
            );
            return h('div', { className: 'wdb-price-row', key },
              h('div', { className: 'wdb-price-name', title: key }, key),
              h('div', { className: 'wdb-price-grid' },
                field('input', t('priceInput')),
                field('output', t('priceOutput')),
                field('cacheRead', t('priceCacheRead')),
                field('cacheWrite', t('priceCacheWrite'))
              )
            );
          }),
        h('div', { className: 'wdb-prices-actions' },
          h('button', { type: 'button', className: 'wdb-btn', onClick: () => actions.commitPrices() }, t('save')),
          h('button', { type: 'button', className: 'wdb-btn', onClick: () => actions.setPriceOpen(false) }, t('cancel'))
        )
      );

      const panel = h('div', {
        className: 'wdb-panel',
        role: 'complementary',
        ref: panelRef,
        'aria-label': t('title'),
        'data-collapsed': snap.collapsed ? 'true' : 'false',
        style: {
          right: `${Math.max(0, window.innerWidth - (geo.x + BADGE_W))}px`,
          top: `${geo.y}px`,
          // Content-driven until the user drags the grip, so no fixed box can
          // leave empty space at the bottom or right. The top-right corner is
          // pinned, so the panel grows down and to the left of the badge.
          ...(snap.sized
            ? { width: `${rect.w}px`, height: `${rect.h}px` }
            : {
                maxWidth: `${Math.max(MIN_W, geo.x + BADGE_W - MAX_MARGIN)}px`,
                maxHeight: `${Math.max(MIN_H, window.innerHeight - MAX_MARGIN - geo.y)}px`,
              }),
          zIndex: Z_INDEX,
        },
      },
        h('div', {
          className: 'wdb-head',
          onPointerDown: onHeadDown,
          onPointerMove: onHeadMove,
          onPointerUp: onHeadUp,
          onPointerCancel: onHeadUp,
        },
          h('span', { className: 'wdb-chips' },
            h('span', {
              className: 'wdb-chip',
              'data-active': elapsed > 0 ? 'true' : 'false',
              title: snap.updated ? t('updated', { time: clock(tag, snap.updated) }) : '',
            },
              h('span', { className: 'wdb-chip-icon' }, h(ClockIcon)),
              t('seconds', { count: elapsed })
            ),
            h('span', { className: 'wdb-chip', title: t('hitRate') },
              h('span', { className: 'wdb-chip-icon' }, h(PercentIcon)),
              hitText
            )
          ),
          h('button', {
            type: 'button',
            className: 'wdb-head-icon',
            'aria-label': t('pricesTitle'),
            'aria-pressed': snap.priceOpen,
            title: t('pricesTitle'),
            onClick: () => actions.setPriceOpen(!snap.priceOpen),
          }, '¥'),
          h('button', {
            type: 'button',
            className: 'wdb-head-icon',
            'aria-label': t('collapse'),
            title: t('collapse'),
            onClick: () => actions.setCollapsed(true),
          }, h(PandaIcon, { size: 18 }))
        ),
        h('div', { className: 'wdb-body' },
          snap.priceOpen ? priceEditor : h('div', { className: 'wdb-hero' },
            h(SpeedGauge, { speed, label: t('speedLabel'), unit: t('speedUnit') }),
            h('div', { className: 'wdb-metrics' },
              h(MetricRow, { label: t('input'), value: totals.known ? formatTokens(totals.input) : '—', title: group(totals.input) }),
              h(MetricRow, { label: t('output'), value: totals.known ? formatTokens(totals.output) : '—', title: group(totals.output) }),
              h(MetricRow, { label: t('total'), value: totals.known ? formatTokens(totals.total) : '—', title: group(totals.total), total: true })
            ),
            h('div', { className: 'wdb-balance' },
              h('span', { className: 'wdb-balance-label' }, t('balance')),
              balanceBody,
              costRow
            )
          ),
          snap.priceOpen ? null : statusLine
        ),
        h('div', {
          className: 'wdb-resize',
          'aria-hidden': 'true',
          onPointerDown: onResizeDown,
          onPointerMove: onResizeMove,
          onPointerUp: onResizeUp,
          onPointerCancel: onResizeUp,
        })
      );

      return h(React.Fragment, null, h('style', null, CSS), snap.collapsed ? badge : panel);
    }

    function Launcher(props) {
      const t = props.t || ((key) => key);
      const snap = React.useSyncExternalStore(props.view.subscribe, props.view.getSnapshot);
      return h(React.Fragment, null,
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: 'wdb-launcher',
          'aria-pressed': snap.visible,
          'aria-label': t('launcher'),
          title: t('launcher'),
          onClick: () => props.actions.setVisible(!snap.visible),
        },
          h(PandaIcon, { size: 16 }),
          h('span', { className: 'wdb-launcher-label' }, t('launcher'))
        )
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'work-dashboard: dictionaries');
      const t = ctx.locale.bind(NS);

      /** One Remote namespace, or null when a composition does not mount it. */
      const remoteNs = (name) => {
        try {
          const remote = ctx.remote;
          return (remote && remote[name]) || null;
        } catch (_error) {
          return null;
        }
      };

      const persisted = loadPersisted();
      const persistedGeo = persisted && persisted.geo;
      const geoValid = persistedGeo
        && Number.isFinite(persistedGeo.x) && Number.isFinite(persistedGeo.y)
        && Number.isFinite(persistedGeo.w) && Number.isFinite(persistedGeo.h);
      const store = createStore({
        geo: geoValid ? persistedGeo : defaultGeo(),
        visible: persisted && typeof persisted.visible === 'boolean' ? persisted.visible : true,
        collapsed: persisted && typeof persisted.collapsed === 'boolean' ? persisted.collapsed : false,
        // Only a user-dragged height is fixed; otherwise the panel hugs its
        // content so no slack can collect at the bottom.
        sized: persisted && typeof persisted.sized === 'boolean' ? persisted.sized : false,
        elapsedSec: 0,
        speed: 0,
        sessions: { state: 'idle', rows: null, busy: false, error: null },
        account: { available: 'unknown', status: null },
        balance: { state: 'idle', wallets: [], bonus: [] },
        updated: 0,
        lastOkAt: 0,
        prices: loadPrices(),
        priceOpen: false,
        cost: { total: 0, priced: 0, unpriced: 0 },
      });

      const usageOverrides = Object.create(null);
      const samples = [];
      const lifetime = { alive: true };
      let smoothedSpeed = 0;
      // Start of the current continuous work window: set when any session starts
      // running, cleared when the last one stops. A parallel session starting or
      // finishing in between leaves it untouched, so the clock never restarts
      // in the middle of multi-session work.
      let workStartedAt = 0;
      let sessionBusy = false;
      let sessionQueued = false;
      let refreshDebounce = null;
      let persistTimer = null;
      let lastRefreshAt = 0;

      const activeLocaleTag = () => {
        try {
          const snap = (typeof ctx.locale.getSnapshot === 'function' && ctx.locale.getSnapshot())
            || (typeof ctx.locale.getLocale === 'function' && ctx.locale.getLocale())
            || null;
          const active = snap && snap.active;
          if (typeof active === 'string') return active;
          if (active && typeof active === 'object') {
            if (typeof active.id === 'string') return active.id;
            if (typeof active.tag === 'string') return active.tag;
            if (typeof active.language === 'string') return active.language;
          }
          if (snap && typeof snap.id === 'string') return snap.id;
        } catch (_error) {}
        return 'en';
      };

      /** Identity of the requesting UI for Platform-reaching account reads, sampled at call time. */
      const clientMeta = () => ({
        version: BUILD_VERSION,
        locale: activeLocaleTag(),
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      });

      /** Runtime diagnostics persisted for out-of-process inspection. */
      const diag = {
        version: BUILD_VERSION,
        startedAt: Date.now(), attempts: 0, ok: 0, failed: 0, lastError: null,
        rows: 0, known: 0, output: 0, elapsedSec: 0, speed: 0, lastOkAt: 0,
        accountStatus: null, balanceState: null, wallets: 0,
        costTotal: 0, costPriced: 0, costUnpriced: 0,
      };
      const publishDiag = () => {
        try {
          const snap = store.getSnapshot();
          diag.accountStatus = snap.account.status;
          diag.balanceState = snap.balance.state;
          diag.wallets = snap.balance.wallets.length;
          diag.costTotal = snap.cost.total;
          diag.costPriced = snap.cost.priced;
          diag.costUnpriced = snap.cost.unpriced;
          window.localStorage.setItem(DIAG_KEY, JSON.stringify(diag));
        } catch (_error) {}
      };
      publishDiag();

      const persistNow = () => {
        try {
          const snap = store.getSnapshot();
          window.localStorage.setItem(LS_KEY, JSON.stringify({ geo: snap.geo, visible: snap.visible, collapsed: snap.collapsed, sized: snap.sized }));
        } catch (_error) {}
      };
      const schedulePersist = () => {
        if (persistTimer !== null) clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
          persistTimer = null;
          if (lifetime.alive) persistNow();
        }, PERSIST_DEBOUNCE_MS);
      };

      const pushSample = (outputTotal) => {
        const now = Date.now();
        samples.push({ at: now, output: Number(outputTotal) || 0 });
        while (samples.length > SAMPLE_MAX) samples.shift();
        while (samples.length > 2 && now - samples[0].at > SAMPLE_WINDOW_MS) samples.shift();
      };

      /** Observed output-token speed over the trailing sample window; 0 when idle. */
      const computeSpeed = (hasRunning) => {
        if (!hasRunning || samples.length < 2) return 0;
        const now = Date.now();
        const fresh = samples.filter((sample) => now - sample.at <= SAMPLE_WINDOW_MS);
        if (fresh.length < 2) return 0;
        const first = fresh[0];
        const last = fresh[fresh.length - 1];
        const seconds = (last.at - first.at) / 1000;
        const output = Math.max(0, last.output - first.output);
        if (seconds < 1 || output <= 0) return 0;
        return Math.round((output / seconds) * 10) / 10;
      };

      const trackRunning = (rows) => {
        const runningCount = rows.filter((row) => row.running).length;
        if (runningCount > 0 && workStartedAt === 0) workStartedAt = Date.now();
        if (runningCount === 0) workStartedAt = 0;
      };

      // Subagent sessions count too: the HUD reports fleet-wide work, and the
      // main session is idle while its subagents run. Dropping them froze the
      // metrics and killed the speed needle exactly then.
      const deriveRows = (items) => items
        .filter((item) => item && !item.blank)
        .map((item) => {
          const values = (item.projections && item.projections.values) || {};
          // `modelSelection` is a summary projection, so the model that served the
          // session is readable here — needed to price non-DeepSeek usage.
          const selection = (values.modelSelection && (values.modelSelection.lastUsed || values.modelSelection.next)) || null;
          return {
            sessionId: item.sessionId,
            running: !!item.running,
            updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
            title: typeof values.title === 'string' ? values.title : null,
            cwd: typeof item.cwd === 'string' ? item.cwd : null,
            provider: selection && typeof selection.provider === 'string' ? selection.provider : null,
            model: selection && typeof selection.model === 'string' ? selection.model : null,
            usage: usageOverrides[item.sessionId] || values.tokenUsage || null,
          };
        })
        .sort((a, b) => b.updatedAt - a.updatedAt);

      // Token counts per session when the plugin first saw it, so the estimate
      // covers "since the HUD started" rather than the whole session history.
      const costBaseline = Object.create(null);

      /** Estimated spend of metered, non-DeepSeek usage since startup, from list/user prices. */
      const computeCost = (rows) => {
        const prices = store.getSnapshot().prices || {};
        let total = 0;
        // Count distinct models, not sessions: the HUD's tooltip says "models".
        const priced = new Set();
        const unpriced = new Set();
        for (const row of rows) {
          if (!row.usage || !row.provider || !row.model) continue;
          if (row.provider === DEEPSEEK_PROVIDER) continue; // the real balance covers it
          if (UNMETERED_PROVIDERS.has(row.provider)) continue; // local: nothing billed
          const buckets = {
            input: Number(row.usage.uncachedInputTokens) || 0,
            output: Number(row.usage.outputTokens) || 0,
            cacheRead: Number(row.usage.cacheReadTokens) || 0,
            cacheWrite: Number(row.usage.cacheWriteTokens) || 0,
          };
          const base = costBaseline[row.sessionId] || (costBaseline[row.sessionId] = buckets);
          const key = `${row.provider}/${row.model}`;
          const price = prices[key];
          const hasPrice = price && (Number(price.input) > 0 || Number(price.output) > 0
            || Number(price.cacheRead) > 0 || Number(price.cacheWrite) > 0);
          if (!hasPrice) {
            unpriced.add(key);
            continue;
          }
          priced.add(key);
          total +=
            (Math.max(0, buckets.input - base.input) * (Number(price.input) || 0)) / 1e6
            + (Math.max(0, buckets.output - base.output) * (Number(price.output) || 0)) / 1e6
            + (Math.max(0, buckets.cacheRead - base.cacheRead) * (Number(price.cacheRead) || 0)) / 1e6
            + (Math.max(0, buckets.cacheWrite - base.cacheWrite) * (Number(price.cacheWrite) || 0)) / 1e6;
        }
        return { total: Math.round(total * 100) / 100, priced: priced.size, unpriced: unpriced.size };
      };

      /**
       * Bound one Remote round-trip. The underlying call keeps running, but the
       * caller stops waiting, so a stuck Host projection rebuild can never hold
       * the refresh lock forever.
       */
      const withTimeout = (promise, label) => {
        let timer = null;
        const guard = new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`${label} timed out`);
            error.code = 'timeout';
            reject(error);
          }, REFRESH_TIMEOUT_MS);
        });
        return Promise.race([promise, guard]).finally(() => {
          if (timer !== null) clearTimeout(timer);
        });
      };

      // Per-session live-usage read times. The session LIST projection settles at
      // checkpoint time, so its `tokenUsage` goes stale while a session runs —
      // trusting it alone freezes every total and the speed needle.
      const usageReadAt = Object.create(null);

      const refreshUsage = async (rows) => {
        const targets = rows.filter((row) => {
          if (!row.usage) return true;              // nothing to show yet
          if (row.running) return true;             // live session: always re-read
          return row.updatedAt > (usageReadAt[row.sessionId] || 0); // changed since last read
        }).slice(0, FALLBACK_USAGE_ROWS);
        if (!targets.length) return;
        const sessionNs = remoteNs('session');
        if (!sessionNs || typeof sessionNs.projections !== 'function') return;
        for (let index = 0; index < targets.length; index += FALLBACK_USAGE_CHUNK) {
          const chunk = targets.slice(index, index + FALLBACK_USAGE_CHUNK);
          await Promise.all(chunk.map(async (row) => {
            try {
              const res = await withTimeout(sessionNs.projections({ sessionId: row.sessionId }), 'session/projections');
              if (!lifetime.alive || !res || !res.ok || !res.value || !res.value.values || !res.value.values.tokenUsage) return;
              usageOverrides[row.sessionId] = res.value.values.tokenUsage;
              usageReadAt[row.sessionId] = Date.now();
              row.usage = res.value.values.tokenUsage;
            } catch (_error) {}
          }));
          if (!lifetime.alive) return;
          const snap = store.getSnapshot();
          if (snap.sessions.state === 'ready') {
            store.patch({ sessions: { ...snap.sessions } });
            // Sample the freshly read output so the needle reacts to this poll,
            // and publish it so the live value is observable from outside.
            const live = sumUsage(snap.sessions.rows || []);
            pushSample(live.output);
            diag.output = live.output;
            diag.known = live.known;
            diag.rows = (snap.sessions.rows || []).length;
            publishDiag();
          }
        }
      };

      const refreshSessions = async () => {
        if (sessionBusy) {
          sessionQueued = true;
          return;
        }
        sessionBusy = true;
        lastRefreshAt = Date.now();
        diag.attempts += 1;
        const before = store.getSnapshot().sessions;
        store.patch({ sessions: before.rows ? { ...before, busy: true } : { ...before, state: 'loading', busy: true } });
        try {
          const sessionNs = remoteNs('session');
          if (!sessionNs || typeof sessionNs.list !== 'function') {
            const error = new Error('session namespace unavailable');
            error.code = 'unavailable';
            throw error;
          }
          const items = [];
          let cursor;
          for (let page = 0; page < 20; page++) {
            const res = await withTimeout(sessionNs.list(cursor === undefined ? {} : { cursor }), 'session/list');
            if (!lifetime.alive) return;
            if (!res || !res.ok) {
              const error = new Error('session list failed');
              error.code = res && res.error ? res.error.code : 'failed';
              throw error;
            }
            const value = res.value || {};
            if (Array.isArray(value.items)) items.push(...value.items);
            const next = typeof value.cursor === 'string' && value.cursor && value.cursor !== cursor ? value.cursor : null;
            if (!next) break;
            cursor = next;
          }
          if (!lifetime.alive) return;
          const rows = deriveRows(items);
          trackRunning(rows);
          pushSample(sumUsage(rows).output);
          store.patch({
            sessions: { state: 'ready', rows, busy: false, error: null },
            cost: computeCost(rows),
            updated: Date.now(),
            lastOkAt: Date.now(),
          });
          // Detached: the per-session usage refresh must never hold the refresh
          // lock. Each of its own calls is bounded by withTimeout as well.
          void refreshUsage(rows);
          const seen = sumUsage(rows);
          diag.ok += 1;
          diag.lastError = null;
          diag.rows = rows.length;
          diag.known = seen.known;
          diag.output = seen.output;
          diag.lastOkAt = Date.now();
          publishDiag();
        } catch (error) {
          if (!lifetime.alive) return;
          const code = error && error.code ? error.code : 'failed';
          diag.failed += 1;
          diag.lastError = code;
          publishDiag();
          const current = store.getSnapshot().sessions;
          store.patch({
            sessions: current.rows
              ? { ...current, busy: false, error: code }
              : { state: 'error', rows: null, busy: false, error: code },
          });
        } finally {
          sessionBusy = false;
          if (sessionQueued) {
            sessionQueued = false;
            if (lifetime.alive) void refreshSessions();
          }
        }
      };

      const scheduleRefresh = (delay) => {
        if (refreshDebounce !== null) clearTimeout(refreshDebounce);
        refreshDebounce = setTimeout(() => {
          refreshDebounce = null;
          if (lifetime.alive) void refreshSessions();
        }, delay === undefined ? EVENT_REFRESH_DEBOUNCE_MS : delay);
      };

      const refreshBalance = async () => {
        const accountNs = remoteNs('account');
        if (!accountNs || typeof accountNs.getBalance !== 'function') return;
        if (store.getSnapshot().account.status !== 'credential-stored') return;
        // Keep the amounts on screen while re-reading: clearing them here made
        // the row flash a dash on every refresh.
        store.patch({ balance: { ...store.getSnapshot().balance, state: 'loading' } });
        try {
          const res = await accountNs.getBalance(clientMeta());
          if (!lifetime.alive) return;
          if (!res || !res.ok) {
            store.patch({ balance: { state: 'failed', wallets: [], bonus: [] } });
            return;
          }
          const value = res.value;
          if (value === null || value === undefined) {
            store.patch({ balance: { state: 'unavailable', wallets: [], bonus: [] } });
            return;
          }
          if (value.status === 'failed') {
            store.patch({ balance: { state: 'failed', wallets: [], bonus: [] } });
            return;
          }
          store.patch({
            balance: {
              state: 'ready',
              wallets: Array.isArray(value.value) ? value.value : [],
              bonus: (Array.isArray(value.bonusWallets) ? value.bonusWallets : []).filter((wallet) => Number(wallet.balance) > 0),
            },
          });
        } catch (_error) {
          if (lifetime.alive) store.patch({ balance: { state: 'failed', wallets: [], bonus: [] } });
        }
        publishDiag();
      };

      // Viewport size at the last geometry reconciliation: a window resize keeps
      // the panel's distance from its nearest edges so it follows the window.
      const viewport = { w: window.innerWidth, h: window.innerHeight };

      /** 1s tick: elapsed seconds of the most recently active running session and speed. */
      const tick = () => {
        const snap = store.getSnapshot();
        const rows = snap.sessions.rows || [];
        const runningRows = rows.filter((row) => row.running);
        let elapsed = 0;
        if (runningRows.length) {
          // Continuous work window: starting or finishing a parallel session does
          // not restart the clock; only the whole fleet going idle does.
          if (workStartedAt === 0) workStartedAt = Date.now();
          elapsed = Math.max(0, Math.floor((Date.now() - workStartedAt) / 1000));
        } else {
          workStartedAt = 0;
        }
        // Exponentially smoothed speed: the needle glides instead of jumping.
        const raw = computeSpeed(runningRows.length > 0);
        smoothedSpeed = runningRows.length ? smoothedSpeed + (raw - smoothedSpeed) * 0.35 : smoothedSpeed * 0.5;
        if (smoothedSpeed < 0.05) smoothedSpeed = 0;
        const speed = Math.round(smoothedSpeed * 10) / 10;
        diag.elapsedSec = elapsed;
        diag.speed = speed;
        if (elapsed !== snap.elapsedSec || speed !== snap.speed) {
          store.patch({ elapsedSec: elapsed, speed });
          publishDiag();
        }
        // Sample usage on a short interval while work runs, and on a slower one
        // when idle: after a stall or a session started elsewhere, the HUD still
        // recovers on its own.
        const interval = runningRows.length ? POLL_MS : IDLE_POLL_MS;
        if (Date.now() - lastRefreshAt >= interval) void refreshSessions();
      };

      const actions = {
        setVisible(value) {
          store.patch({ visible: !!value });
          schedulePersist();
        },
        setCollapsed(value) {
          const snap = store.getSnapshot();
          const next = { collapsed: !!value };
          if (value && !snap.collapsed) {
            // Land the badge on the panel's bottom-right corner: expanding again
            // opens the panel up-left from the badge.
            const anchor = anchorOf(panelRect(snap.geo));
            next.geo = { ...snap.geo, x: anchor.x, y: anchor.y };
          }
          store.patch(next);
          schedulePersist();
        },
        setGeo(patch) {
          const current = store.getSnapshot().geo;
          store.patch({ geo: { ...current, ...patch } });
        },
        /** Pin the height from here on: the user has taken over sizing. */
        markSized() {
          if (!store.getSnapshot().sized) store.patch({ sized: true });
        },
        persistGeo: schedulePersist,
        clampGeo() {
          const geo = store.getSnapshot().geo;
          viewport.w = window.innerWidth;
          viewport.h = window.innerHeight;
          if (!geo) return;
          if (store.getSnapshot().collapsed) {
            // The badge anchors the parked corner; the panel's remembered
            // width/height must survive the collapse.
            const place = fitBadge(geo);
            store.patch({ geo: { ...geo, x: place.x, y: place.y } });
          } else {
            const fit = fitGeo(panelRect(geo));
            const anchor = anchorOf(fit);
            store.patch({ geo: { ...geo, x: anchor.x, y: anchor.y, w: fit.w, h: fit.h } });
          }
        },
        refresh() {
          void refreshSessions();
          void refreshBalance();
        },
        setPriceOpen(value) {
          store.patch({ priceOpen: !!value });
        },
        setPrice(key, field, value) {
          const prices = store.getSnapshot().prices;
          store.patch({ prices: { ...prices, [key]: { ...(prices[key] || {}), [field]: value } } });
        },
        commitPrices() {
          const snap = store.getSnapshot();
          savePrices(snap.prices);
          store.patch({ priceOpen: false, cost: computeCost(snap.sessions.rows || []) });
        },
      };

      const view = { subscribe: store.subscribe, getSnapshot: store.getSnapshot };

      /** Reconcile geometry after a viewport change, keeping the badge (the parked corner) at its distance from the edges. */
      const onViewportChange = () => {
        const snap = store.getSnapshot();
        const geo = snap.geo;
        const previous = { w: viewport.w, h: viewport.h };
        viewport.w = window.innerWidth;
        viewport.h = window.innerHeight;
        if (!geo) return;
        // The badge is the top-right corner in both states: keep its distance
        // from the right and top edges, so the panel follows the window.
        const fromRight = previous.w - (geo.x + BADGE_W);
        const x = clamp(window.innerWidth - fromRight - BADGE_W, 0, Math.max(0, window.innerWidth - MAX_MARGIN - BADGE_W));
        const y = clamp(geo.y, 0, Math.max(0, window.innerHeight - MAX_MARGIN - BADGE_H));
        if (snap.collapsed) {
          const place = fitBadge({ x, y });
          actions.setGeo({ x: place.x, y: place.y });
        } else {
          const fit = fitGeo(panelRect({ x, y, w: geo.w, h: geo.h }));
          const anchor = anchorOf(fit);
          actions.setGeo({ x: anchor.x, y: anchor.y });
        }
        actions.persistGeo();
      };

      ctx.effect(() => {
        actions.clampGeo();
        const onResize = () => {
          if (lifetime.alive) onViewportChange();
        };
        window.addEventListener('resize', onResize);
        return () => {
          window.removeEventListener('resize', onResize);
        };
      }, 'work-dashboard: viewport');

      ctx.effect(() => {
        const ticker = setInterval(() => {
          if (lifetime.alive) tick();
        }, TICK_MS);
        // Chromium throttles timers while the window is occluded, so the HUD can
        // look frozen on return. Catch up as soon as the page is visible again.
        const onVisible = () => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
          if (!lifetime.alive) return;
          scheduleRefresh(0);
          void refreshBalance();
        };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onVisible);
        return () => {
          clearInterval(ticker);
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
          window.removeEventListener('focus', onVisible);
          if (persistTimer !== null) {
            clearTimeout(persistTimer);
            persistTimer = null;
          }
          if (refreshDebounce !== null) {
            clearTimeout(refreshDebounce);
            refreshDebounce = null;
          }
        };
      }, 'work-dashboard: timers');

      ctx.effect(() => {
        const disposers = [];
        let eventsAvailable = true;
        for (const key of ['api-session/status', 'api-session/added', 'api-session/removed', 'api-session/activity']) {
          try {
            const dispose = ctx.remote.$on(key, () => scheduleRefresh(EVENT_REFRESH_DEBOUNCE_MS));
            if (typeof dispose === 'function') disposers.push(dispose);
          } catch (error) {
            eventsAvailable = false;
            console.warn('[work-dashboard] forwarded event unavailable:', key, error);
          }
        }
        if (!eventsAvailable) {
          const id = setInterval(() => {
            if (lifetime.alive) void refreshSessions();
          }, FALLBACK_POLL_MS);
          disposers.push(() => clearInterval(id));
        }
        disposers.push(ctx.on('connection/reset', () => scheduleRefresh(0)));
        void refreshSessions();
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch (_error) {}
          }
        };
      }, 'work-dashboard: sessions');

      ctx.effect(() => {
        const accountNs = remoteNs('account');
        if (!accountNs || typeof accountNs.watch !== 'function') {
          store.patch({
            account: { available: false, status: null },
            balance: { state: 'unavailable', wallets: [], bonus: [] },
          });
          return () => {};
        }
        let generation = 0;
        let handle = null;
        const start = () => {
          const mine = ++generation;
          (async () => {
            try {
              const stream = accountNs.watch();
              handle = stream;
              for await (const viewValue of stream) {
                if (mine !== generation || !lifetime.alive) break;
                store.patch({ account: { available: true, status: viewValue && viewValue.status ? viewValue.status : null } });
                if (viewValue && viewValue.status === 'credential-stored') void refreshBalance();
                else store.patch({ balance: { state: 'idle', wallets: [], bonus: [] } });
              }
            } catch (error) {
              if (mine === generation && lifetime.alive) store.patch({ account: { available: true, status: 'failed' } });
            } finally {
              if (mine === generation) handle = null;
            }
          })();
        };
        start();
        const offReset = ctx.on('connection/reset', () => {
          if (lifetime.alive) start();
        });
        return () => {
          generation += 1;
          try {
            offReset();
          } catch (_error) {}
          if (handle && typeof handle.dispose === 'function') {
            try {
              handle.dispose();
            } catch (_error) {}
          }
          handle = null;
        };
      }, 'work-dashboard: account');

      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'work-dashboard',
        order: 10,
        label: () => t('title'),
        locale: NS,
        inject: () => ({ view, actions, localeTag: activeLocaleTag }),
      }, Dashboard)), 'work-dashboard: overlay');

      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'work-dashboard-toggle',
        order: 10,
        label: () => t('launcher'),
        locale: NS,
        inject: () => ({ view, actions }),
      }, Launcher)), 'work-dashboard: launcher');

      ctx.effect(() => () => {
        lifetime.alive = false;
      }, 'work-dashboard: lifetime');
    }

    return {
      // `remote.<namespace>` are Cordis services in their own right: reading
      // ctx.remote.account / ctx.remote.session without declaring them here
      // throws `cannot get property "remote.*" without inject`, which fails the
      // entry's fiber and aborts web boot.
      inject: ['slots', 'locale', 'remote', 'remote.session', 'remote.account'],
      apply,
    };
  },
});
