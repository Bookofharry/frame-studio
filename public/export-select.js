(function () {
  const dialog = document.getElementById('export-dialog');
  const controls = [];
  let opened = null;
  const icons = {
    resolution: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 9h3M7 9v3m10 3h-3m3 0v-3"/>',
    quality: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.4l6.1-.9Z"/>',
    fps: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  };
  const svg = content => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;

  function close(restoreFocus = false) {
    if (!opened) return;
    const control = opened;
    opened = null;
    control.menu.hidden = true;
    control.button.setAttribute('aria-expanded', 'false');
    control.button.removeAttribute('aria-activedescendant');
    if (restoreFocus) control.button.focus();
  }
  function position(control) {
    const rect = control.button.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 300), innerWidth - 24);
    const below = innerHeight - rect.bottom - 20;
    const above = rect.top - 20;
    const upwards = below < 280 && above > below;
    Object.assign(control.menu.style, {
      width: `${width}px`, left: `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`,
      maxHeight: `${Math.max(80, upwards ? above : below)}px`,
      top: upwards ? 'auto' : `${rect.bottom + 8}px`,
      bottom: upwards ? `${innerHeight - rect.top + 8}px` : 'auto'
    });
  }
  function highlight(control, index) {
    control.active = Math.max(0, Math.min(index, control.select.options.length - 1));
    control.menu.querySelectorAll('[role="option"]').forEach((row, i) => row.classList.toggle('is-highlighted', i === control.active));
    const row = control.menu.querySelectorAll('[role="option"]')[control.active];
    if (row) {
      control.button.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    }
  }
  function choose(control, index) {
    if (control.select.disabled || control.select.options[index]?.disabled) return;
    control.select.selectedIndex = index;
    control.select.dispatchEvent(new Event('change', { bubbles: true }));
    refresh();
    close(true);
  }
  function open(control, index = control.select.selectedIndex) {
    if (control.select.disabled) return;
    close();
    opened = control;
    refresh();
    control.menu.hidden = false;
    control.button.setAttribute('aria-expanded', 'true');
    position(control);
    highlight(control, index);
  }
  function refresh() {
    for (const control of controls) {
      const { select, button, menu, value } = control;
      const selected = select.options[select.selectedIndex];
      value.textContent = selected?.textContent || 'Choose an option';
      button.disabled = select.disabled;
      if (select.disabled && opened === control) close();
      menu.replaceChildren();
      [...select.options].forEach((option, index) => {
        const row = document.createElement('div');
        row.id = `${select.id}-choice-${index}`;
        row.className = 'export-choice';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(option.selected));
        row.setAttribute('aria-disabled', String(option.disabled));
        row.dataset.value = option.value;
        const text = document.createElement('span'); text.className = 'export-choice-text';
        const title = document.createElement('span'); title.className = 'export-choice-title'; title.textContent = option.textContent;
        text.append(title);
        if (option.dataset.detail) { const detail = document.createElement('span'); detail.className = 'export-choice-detail'; detail.textContent = option.dataset.detail; text.append(detail); }
        row.append(text);
        if (option.dataset.badge) { const badge = document.createElement('span'); badge.className = 'export-choice-badge'; badge.textContent = option.dataset.badge; row.append(badge); }
        const check = document.createElement('span'); check.className = 'export-choice-check'; check.innerHTML = svg('<path d="m5 12 4 4L19 6"/>'); row.append(check);
        row.addEventListener('pointermove', () => { if (control.active !== index) highlight(control, index); });
        row.addEventListener('pointerdown', event => event.preventDefault());
        row.addEventListener('click', () => choose(control, index));
        menu.append(row);
      });
      if (opened === control) {
        position(control);
        highlight(control, control.active);
      }
    }
  }

  for (const id of ['resolution', 'quality', 'fps']) {
    const select = document.getElementById(id);
    const label = dialog.querySelector(`label[for="${id}"]`);
    label.id = `${id}-label`;
    const button = document.createElement('button');
    button.type = 'button'; button.id = `${id}-picker`; button.className = 'export-picker';
    button.setAttribute('role', 'combobox'); button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', `${id}-menu`);
    button.setAttribute('aria-labelledby', label.id); button.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
    button.innerHTML = `<span class="export-picker-icon">${svg(icons[id])}</span><span class="export-picker-value"></span><span class="export-picker-caret">${svg('<path d="m7 10 5 5 5-5"/>')}</span>`;
    const menu = document.createElement('div');
    menu.id = `${id}-menu`; menu.className = 'export-picker-menu'; menu.hidden = true;
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-labelledby', label.id);
    const control = { select, button, menu, value: button.querySelector('.export-picker-value'), active: select.selectedIndex, search: '', searchAt: 0 };
    controls.push(control);
    select.hidden = true; select.tabIndex = -1;
    label.htmlFor = button.id;
    select.after(button); dialog.append(menu);
    button.addEventListener('click', () => opened === control ? close() : open(control));
    button.addEventListener('keydown', event => {
      const isOpen = opened === control;
      if (event.key === 'Tab') { close(); return; }
      if (event.key === 'Escape' && isOpen) { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (!isOpen) open(control);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? select.options.length - 1 : control.active + (event.key === 'ArrowDown' ? 1 : -1);
        highlight(control, index); return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (isOpen) choose(control, control.active); else open(control);
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (!isOpen) open(control);
        control.search = (Date.now() - control.searchAt < 700 ? control.search : '') + event.key.toLowerCase();
        control.searchAt = Date.now();
        const index = [...select.options].findIndex(option => option.textContent.toLowerCase().startsWith(control.search));
        if (index >= 0) highlight(control, index);
      }
    });
    button.addEventListener('blur', () => { if (opened === control) close(); });
    select.addEventListener('change', refresh);
  }
  document.addEventListener('pointerdown', event => { if (opened && !opened.button.contains(event.target) && !opened.menu.contains(event.target)) close(); });
  dialog.addEventListener('close', () => close());
  dialog.addEventListener('scroll', () => { if (opened) position(opened); });
  document.getElementById('export-advanced').addEventListener('toggle', event => { if (!event.target.open && opened?.select.id === 'fps') close(); });
  window.addEventListener('resize', () => { if (opened) position(opened); });
  window.FrameExportSelect = { refresh };
  refresh();
})();
