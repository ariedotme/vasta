// Right-click menu entries that save without opening the popup; the badge shows the outcome.
import { isWebPage, saveWeblink } from './vasta.js'

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'save-page', title: 'Save page to Vasta', contexts: ['page'] })
  chrome.contextMenus.create({ id: 'save-link', title: 'Save link to Vasta', contexts: ['link'] })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'save-link' ? info.linkUrl : tab?.url
  if (!isWebPage(url)) return
  const title = info.menuItemId === 'save-page' ? tab?.title : undefined
  try {
    await saveWeblink({ url, title })
    await badge(tab?.id, '✓', '#16a34a')
  } catch (error) {
    console.warn('Vasta:', error)
    await badge(tab?.id, '!', '#dc2626')
  }
})

async function badge(tabId, text, color) {
  if (tabId === undefined) return
  await chrome.action.setBadgeBackgroundColor({ tabId, color })
  await chrome.action.setBadgeText({ tabId, text })
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 3000)
}
