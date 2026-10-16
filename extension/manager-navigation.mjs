const VIEWS = {
  collection: ['商品采集', '添加商品名称，采集商品与规格，导出 Excel'],
  conversion: ['图片转换', '按类型转换图片，上传 OSS 后自动更新导出链接'],
  selling: ['商品卖点图', '上传商品图片，生成文案并制作卖点图'],
  settings: ['服务设置', '管理后台连接、图片翻译、OSS 与百炼配置']
};

function defaultStorage(document) {
  try { return document.defaultView?.localStorage; } catch { return null; }
}

// Keep every business node mounted: navigation must never stop a task or reload a form.
export function createManagerNavigation({document, storage = defaultStorage(document)} = {}) {
  const $ = id => document.getElementById(id);
  const app = document.querySelector('.app');
  const content = document.querySelector('.app-content');
  const mobileQuery = document.defaultView?.matchMedia?.('(max-width:760px)');
  const isMobile = () => mobileQuery?.matches ?? true;
  function closeMobile(restoreFocus = false) {
    app.classList.remove('navigation-open');
    content.inert = false;
    $('sidebar-toggle').setAttribute('aria-expanded', 'false');
    $('sidebar-toggle').setAttribute('aria-label', '展开导航菜单');
    if (restoreFocus) $('sidebar-toggle').focus?.();
  }
  function select(view, {target, focus = false} = {}) {
    if (!Object.hasOwn(VIEWS, view)) view = 'collection';
    for (const page of document.querySelectorAll('[data-workspace-view]')) page.hidden = page.dataset.workspaceView !== view;
    for (const [name] of Object.entries(VIEWS)) {
      const nav = $('nav-' + name);
      if (name === view) nav.setAttribute('aria-current', 'page');
      else nav.removeAttribute('aria-current');
    }
    $('workspace-title').textContent = VIEWS[view][0];
    $('workspace-description').textContent = VIEWS[view][1];
    document.title = `${VIEWS[view][0]} · 商品采集助手`;
    closeMobile();
    try { storage?.setItem('collector-manager-view', view); } catch { /* A storage failure must not block navigation. */ }
    const destination = target && $(target);
    if (destination && destination.closest('[data-workspace-view]')?.dataset.workspaceView === view) {
      for (let parent = destination; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
      destination.setAttribute('tabindex', '-1');
      destination.focus?.({preventScroll:true});
      destination.scrollIntoView?.({block:'start',behavior:'smooth'});
    } else if (focus) {
      $('workspace-title').focus?.({preventScroll:true});
      document.defaultView?.scrollTo?.({top:0,behavior:'instant'});
    }
    return view;
  }
  for (const button of document.querySelectorAll('[data-view-target]')) button.addEventListener('click', () => select(button.dataset.viewTarget, {focus:true}));
  for (const button of document.querySelectorAll('[data-settings-target]')) button.addEventListener('click', () => select('settings', {target:button.dataset.settingsTarget}));
  $('navigation-group-toggle').addEventListener('click', () => {
    const group = $('navigation-group'), expanded = group.hidden;
    group.hidden = !expanded;
    $('navigation-group-toggle').setAttribute('aria-expanded', String(expanded));
  });
  $('sidebar-toggle').addEventListener('click', () => {
    if (app.classList.contains('navigation-open')) { closeMobile(true); return; }
    app.classList.add('navigation-open');
    $('sidebar-toggle').setAttribute('aria-expanded', 'true');
    $('sidebar-toggle').setAttribute('aria-label', '关闭导航菜单');
    if (isMobile()) {
      content.inert = true;
      const initial = $('navigation-group').hidden ? $('navigation-group-toggle') : document.querySelector('.nav-item[aria-current="page"]');
      initial?.focus?.();
    }
  });
  $('navigation-backdrop').addEventListener('click', () => closeMobile(true));
  document.addEventListener('keydown', event => {
    if (!app.classList.contains('navigation-open') || !isMobile()) return;
    if (event.key === 'Escape') { event.preventDefault(); closeMobile(true); }
    if (event.key === 'Tab') {
      const buttons = [...$('app-sidebar').querySelectorAll('button:not([disabled])')].filter(el => !el.closest('[hidden]'));
      const index = buttons.indexOf(document.activeElement);
      if (index < 0 || (!event.shiftKey && index === buttons.length - 1) || (event.shiftKey && index === 0)) {
        event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus();
      }
    }
  });
  mobileQuery?.addEventListener('change', event => { if (!event.matches) closeMobile(); });
  let initial;
  try { initial = storage?.getItem('collector-manager-view'); } catch { /* Default view remains available. */ }
  select(initial);
  return {select};
}
