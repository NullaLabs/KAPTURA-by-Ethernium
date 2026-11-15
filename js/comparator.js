/**
 * KAPTURA INTERACTIVE A/B COMPARATOR
 * Split-screen Before vs After slider supporting both images and synchronized videos.
 */
(function (root) {
  'use strict';

  function render(container, opts) {
    if (!container) return;
    opts = opts || {};
    const { beforeSrc, afterSrc, isVideo = false, beforeLabel = 'ORIGINAL', afterLabel = 'PROCESSED' } = opts;
    if (!beforeSrc || !afterSrc) {
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'compare-wrap';

    const tagLeft = document.createElement('div');
    tagLeft.className = 'compare-tag left';
    tagLeft.textContent = beforeLabel;

    const tagRight = document.createElement('div');
    tagRight.className = 'compare-tag right';
    tagRight.textContent = afterLabel;

    const afterLayer = document.createElement('div');
    afterLayer.className = 'compare-after';

    let beforeEl, afterEl;
    if (isVideo) {
      beforeEl = document.createElement('video');
      afterEl = document.createElement('video');
      [beforeEl, afterEl].forEach((v) => {
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.autoplay = true;
        v.crossOrigin = 'anonymous';
        v.className = 'compare-media';
      });
      beforeEl.src = beforeSrc;
      afterEl.src = afterSrc;
      beforeEl.addEventListener('timeupdate', () => {
        if (Math.abs(beforeEl.currentTime - afterEl.currentTime) > 0.15) {
          try { afterEl.currentTime = beforeEl.currentTime; } catch {}
        }
      });
      beforeEl.play().catch(() => {});
      afterEl.play().catch(() => {});
    } else {
      beforeEl = document.createElement('img');
      afterEl = document.createElement('img');
      beforeEl.className = 'compare-media';
      afterEl.className = 'compare-media';
      beforeEl.alt = beforeLabel;
      afterEl.alt = afterLabel;
      beforeEl.src = beforeSrc;
      afterEl.src = afterSrc;
    }

    afterLayer.appendChild(afterEl);
    wrap.appendChild(beforeEl);
    wrap.appendChild(afterLayer);
    wrap.appendChild(tagLeft);
    wrap.appendChild(tagRight);

    const divider = document.createElement('div');
    divider.className = 'compare-divider';
    divider.style.left = '50%';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = '50';
    slider.className = 'compare-slider';
    slider.setAttribute('aria-label', 'Comparador Antes y Después');

    const updateSplit = (pct) => {
      const clamped = Math.max(0, Math.min(100, Number(pct) || 50));
      afterLayer.style.clipPath = `inset(0 0 0 ${clamped}%)`;
      divider.style.left = `${clamped}%`;
    };
    updateSplit(50);
    slider.addEventListener('input', (e) => updateSplit(e.target.value));

    wrap.appendChild(divider);
    wrap.appendChild(slider);
    container.appendChild(wrap);
  }

  const api = { render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaComparator = api;
})(typeof self !== 'undefined' ? self : this);
