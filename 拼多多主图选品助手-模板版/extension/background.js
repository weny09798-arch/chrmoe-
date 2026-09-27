let opening;
chrome.action.onClicked.addListener(() => {
  if (opening) return;
  opening = (async () => {
    const { managerTabId } = await chrome.storage.session.get('managerTabId');
    const tab = managerTabId ? await chrome.tabs.get(managerTabId).catch(() => null) : null;
    if (tab?.url === chrome.runtime.getURL('manager.html')) {
      await chrome.tabs.update(managerTabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } else {
      const created = await chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
      await chrome.storage.session.set({ managerTabId: created.id });
    }
  })().catch(console.error).finally(() => { opening = null; });
});
