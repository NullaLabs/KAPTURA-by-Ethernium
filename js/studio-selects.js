/**
 * KAPTURA STUDIO SELECTS
 * Upgrades native <select> elements inside .control-card into dark 3D obsidian crystal
 * popovers while keeping the underlying <select> synchronized bidirectionally.
 */
(function (root) {
  'use strict';

  function closeAll(except) {
    document.querySelectorAll('.kpr-select.open').forEach((wrap) => {
      if (wrap !== except) {
        wrap.classList.remove('open');
        const card = wrap.closest('.control-card');
        if (card) card.style.zIndex = '';
      }
    });
  }

  function enhanceSelect(sel) {
    if (!sel || sel.dataset.kprEnhanced === '1') return;
    sel.dataset.kprEnhanced = '1';

    const wrap = document.createElement('div');
    wrap.className = 'kpr-select';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'kpr-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');

    const labelSpan = document.createElement('span');
    labelSpan.className = 'kpr-select-label';
    const chevron = document.createElement('span');
    chevron.className = 'kpr-select-chevron';
    chevron.textContent = '▾';
    trigger.appendChild(labelSpan);
    trigger.appendChild(chevron);

    const menu = document.createElement('div');
    menu.className = 'kpr-select-menu';
    menu.setAttribute('role', 'listbox');

    const rebuildOptions = () => {
      menu.innerHTML = '';
      Array.from(sel.children).forEach((child) => {
        if (child.tagName === 'OPTGROUP') {
          const grp = document.createElement('div');
          grp.className = 'kpr-select-group';
          grp.textContent = child.label || '';
          menu.appendChild(grp);
          Array.from(child.children).forEach((opt) => menu.appendChild(makeOptBtn(opt)));
        } else if (child.tagName === 'OPTION') {
          menu.appendChild(makeOptBtn(child));
        }
      });
      syncText();
    };

    const makeOptBtn = (opt) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'kpr-select-opt' + (opt.selected ? ' selected' : '');
      item.dataset.value = opt.value;
      item.textContent = opt.textContent;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        closeAll();
      });
      return item;
    };

    const syncText = () => {
      const chosen = sel.options[sel.selectedIndex];
      labelSpan.textContent = chosen ? chosen.textContent : '';
      menu.querySelectorAll('.kpr-select-opt').forEach((btn) => {
        btn.classList.toggle('selected', btn.dataset.value === sel.value);
      });
    };

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !wrap.classList.contains('open');
      closeAll(wrap);
      wrap.classList.toggle('open', willOpen);
      const card = wrap.closest('.control-card');
      if (card) card.style.zIndex = willOpen ? '60' : '';
    });

    sel.addEventListener('change', syncText);
    rebuildOptions();

    sel.parentNode.insertBefore(wrap, sel);
    sel.classList.add('sr-only-select');
    wrap.appendChild(sel);
    wrap.appendChild(trigger);
    wrap.appendChild(menu);
  }

  function enhanceAll() {
    document.querySelectorAll('.control-card select').forEach(enhanceSelect);
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('click', () => closeAll());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhanceAll);
    else enhanceAll();
  }

  const api = { enhanceAll, enhanceSelect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapturaStudioSelects = api;
})(typeof self !== 'undefined' ? self : this);
