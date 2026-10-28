// skald — small slider factory used inside the control bar's shadow DOM.

'use strict';

/**
 * @param {object} opts
 * @param {number} opts.min
 * @param {number} opts.max
 * @param {number} opts.step
 * @param {number} opts.value
 * @param {boolean} [opts.readout] show a formatted value readout
 * @param {(v:number)=>string} [opts.format]
 * @param {number} [opts.width] track width in px
 * @param {string} [opts.title]
 * @param {(v:number)=>void} [opts.onInput] fired on user interaction only
 */
export function createSlider(opts = {}) {
  const {
    min = 0,
    max = 1,
    step = 0.1,
    value = min,
    readout = false,
    format = null,
    width = null,
    title = '',
    onInput = () => {},
  } = opts;

  const wrap = document.createElement('span');
  wrap.className = 'skald-slider';

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  if (title) input.title = title;
  if (width != null) input.style.width = `${width}px`;
  wrap.appendChild(input);

  let valueEl = null;
  if (readout) {
    valueEl = document.createElement('span');
    valueEl.className = 'skald-slider-value';
    wrap.appendChild(valueEl);
  }

  const fmt = format || ((v) => String(v));
  const update = () => {
    if (valueEl) valueEl.textContent = fmt(Number(input.value));
  };
  input.addEventListener('input', () => {
    update();
    onInput(Number(input.value));
  });
  update();

  return {
    el: wrap,
    input,
    get() {
      return Number(input.value);
    },
    /** Programmatic set — updates UI, does NOT fire onInput. */
    set(v) {
      const n = Number(v);
      if (Number.isFinite(n) && n !== Number(input.value)) {
        input.value = String(n);
        update();
      }
    },
  };
}
