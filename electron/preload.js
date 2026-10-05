'use strict';
/**
 * 桌面壳暴露给页面的最小接口（contextIsolation 打开，走 contextBridge）。
 * 页面里用 `if (window.WWDesktop) { … }` 判断自己是不是跑在桌面壳里 ——
 * 浏览器直接访问 9391 时这个对象不存在，功能自然降级。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('WWDesktop', {
  isDesktop: true,
  platform: process.platform,
  /** 是否设置了开机自启动（读系统里的真实状态） */
  getAutoLaunch: () => ipcRenderer.invoke('ww:get-auto-launch'),
  setAutoLaunch: (on) => ipcRenderer.invoke('ww:set-auto-launch', !!on),
  hideToTray: () => ipcRenderer.invoke('ww:hide-to-tray'),
  openDataDir: () => ipcRenderer.invoke('ww:open-data-dir'),
  /**
   * 用系统默认浏览器打开本地页面。
   * 不能走 window.open：主进程的 setWindowOpenHandler 对同源地址是 allow，
   * 结果是在 Electron 里又开一个窗口，等于没换浏览器（用户嫌 Electron 窗口卡）。
   */
  openInBrowser: () => ipcRenderer.invoke('ww:open-in-browser'),
  info: () => ipcRenderer.invoke('ww:info'),
});
