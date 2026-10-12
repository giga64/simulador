// Componentes de interface sem estado: recebem dados e devolvem HTML/SVG.
// Todo texto vindo de dados passa por escapeHtml.

export const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

// Só links https (evita javascript:, data: etc. vindos de dados externos).
export function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

export const percent = (value) => (value == null ? '–' : value < 1 && value > 0 ? '<1%' : `${Math.round(value)}%`);

export function signed(value, suffix = '') {
  const rounded = Math.round(value);
  if (!rounded) return `0${suffix}`;
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}${suffix}`;
}

// Controle segmentado (sub-abas). Os botões disparam data-act="sub-view".
export function segmented(group, options, value, label) {
  return `<div class="seg" role="group" aria-label="${escapeHtml(label)}">${options
    .map(
      ([key, text]) =>
        `<button type="button" data-act="sub-view" data-group="${group}" data-value="${key}" aria-pressed="${key === value}" class="${key === value ? 'on' : ''}">${escapeHtml(text)}</button>`,
    )
    .join('')}</div>`;
}

export function meter(value, tone = 'accent') {
  const width = Math.max(0, Math.min(100, value || 0));
  return `<span class="meter ${tone}" aria-hidden="true"><i style="width:${width.toFixed(1)}%"></i></span>`;
}

// Gráfico de linhas em SVG. series: [{ label, color, points: [{ x, y }] }].
export function lineChart({ series, xMin, xMax, yMax = 100, yLabel = (v) => `${v}%`, xLabel = (v) => v, title }) {
  const width = 760;
  const height = 280;
  const pad = { left: 44, right: 120, top: 16, bottom: 30 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const x = (value) => pad.left + ((value - xMin) / Math.max(1, xMax - xMin)) * innerWidth;
  const y = (value) => pad.top + innerHeight - (value / yMax) * innerHeight;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((step) => Math.round(step * yMax));
  const xTicks = [];
  const xStep = Math.max(1, Math.ceil((xMax - xMin) / 8));
  for (let value = Math.ceil(xMin); value <= xMax; value += xStep) xTicks.push(value);
  const grid = ticks
    .map(
      (tick) =>
        `<line x1="${pad.left}" x2="${pad.left + innerWidth}" y1="${y(tick)}" y2="${y(tick)}" class="chart-grid"/><text x="${pad.left - 8}" y="${y(tick) + 4}" text-anchor="end" class="chart-axis">${escapeHtml(yLabel(tick))}</text>`,
    )
    .join('');
  const axis = xTicks
    .map(
      (tick) =>
        `<text x="${x(tick)}" y="${height - 8}" text-anchor="middle" class="chart-axis">${escapeHtml(xLabel(tick))}</text>`,
    )
    .join('');
  // Rótulos no fim das linhas: de cima para baixo com espaço mínimo e, se
  // passarem do eixo, empurrados de volta para cima.
  const ends = series
    .filter((item) => item.points.length)
    .map((item) => ({ item, last: item.points[item.points.length - 1] }))
    .sort((a, b) => b.last.y - a.last.y);
  const gap = 15;
  const bottom = pad.top + innerHeight + 4;
  const positions = [];
  ends.forEach(({ last }, index) => {
    positions.push(Math.max(y(last.y) + 4, index ? positions[index - 1] + gap : -Infinity));
  });
  for (let index = positions.length - 1; index >= 0; index--) {
    const limit = index === positions.length - 1 ? bottom : positions[index + 1] - gap;
    positions[index] = Math.min(positions[index], limit);
  }
  const labels = ends
    .map(
      ({ item, last }, index) =>
        `<text x="${x(last.x) + 8}" y="${positions[index]}" class="chart-end" style="fill:${item.color}">${escapeHtml(item.label)} ${escapeHtml(yLabel(Math.round(last.y)))}</text>`,
    )
    .join('');
  const paths = series
    .map((item) => {
      if (!item.points.length) return '';
      const d = item.points
        .map((point, index) => `${index ? 'L' : 'M'}${x(point.x).toFixed(1)},${y(point.y).toFixed(1)}`)
        .join('');
      const dots = item.points
        .map(
          (point) =>
            `<circle cx="${x(point.x).toFixed(1)}" cy="${y(point.y).toFixed(1)}" r="9" class="chart-hit"><title>${escapeHtml(item.label)} · ${escapeHtml(xLabel(point.x))}: ${escapeHtml(yLabel(Math.round(point.y * 10) / 10))}</title></circle>`,
        )
        .join('');
      return `<path d="${d}" class="chart-line" style="stroke:${item.color}"/>${dots}`;
    })
    .join('');
  return `<svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">${grid}${axis}${paths}${labels}</svg>`;
}

// Mapa de posições finais: clube x colocação, intensidade = probabilidade.
export function positionMap({ order, positionsOf, zoneOf, renderTeam, highlight, nameOf }) {
  const positions = order.length;
  const head = Array.from({ length: positions }, (_, i) => `<th class="z${zoneOf(i)}">${i + 1}</th>`).join('');
  const body = order
    .map((code) => {
      const values = positionsOf(code);
      if (!values) return '';
      const cells = values
        .map((value, i) => {
          const alpha = value < 0.5 ? 0 : Math.min(0.92, 0.14 + (value / 100) * 1.15);
          const text = value >= 1 ? Math.round(value) : value >= 0.5 ? '&lt;1' : '';
          return `<td class="cell z${zoneOf(i)}" style="--a:${alpha.toFixed(2)}" title="${escapeHtml(nameOf(code))}: ${value.toFixed(1).replace('.', ',')}% em ${i + 1}º">${text}</td>`;
        })
        .join('');
      return `<tr class="${code === highlight ? 'hl' : ''}"><th scope="row" class="club">${renderTeam(code)}</th>${cells}</tr>`;
    })
    .join('');
  return `<div class="sc"><table class="pmap"><thead><tr><th class="club">Clube</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
