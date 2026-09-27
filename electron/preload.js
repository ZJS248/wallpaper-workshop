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
  info: () => ipcRenderer.invoke('ww:info'),
});
