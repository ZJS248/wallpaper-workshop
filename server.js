'use strict';
/**
 * 入口转发：`node server.js` 与 `node server/server.js` 等价。
 * 真正的实现在 server/server.js（与接口实现放在一起，方便按目录阅读）。
 */
require('./server/server.js');
