'use strict';
/**
 * Wallpaper Engine 的**依赖关系**。
 *
 * 规则来自 WE 自己的项目文件（wallpaper-manager 的扫描器也是这么读的）：
 *   子壁纸的 project.json 里有 `"dependency": "<父壁纸的工作坊 id>"`（有的版本是 `"dependencies"`）。
 * 于是：
 *   - 订阅子壁纸时，父壁纸也应该一起订阅（否则子壁纸加载不了）；
 *   - 取消父壁纸时，依赖它的子壁纸（含间接依赖）会被一起取消。
 *
 * 注意：Steam 的 GetPublishedFileDetails 里**没有**这个信息（实测 WE 项目的 children 都是空的），
 * 只有把项目下载到本地、读到 project.json 才知道。
 */

const fs = require('fs');
const path = require('path');

const DEP_RE = /"(?:dependencies|dependency)"\s*:\s*"(\d{6,})"/;
const TTL_MS = 60 * 1000;
const cache = new Map(); // `${wsDir}|${id}` → { at, parent }

/** 读某个本地项目的父壁纸 id（没有依赖/读不到 → ''） */
function readDependency(wsDir, id) {
  const key = wsDir + '|' + id;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.parent;
  let parent = '';
  try {
    const file = path.join(wsDir, String(id), 'project.json');
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      const m = text.match(DEP_RE);
      if (m && m[1] !== String(id)) parent = m[1];
    }
  } catch (e) {
    /* 读不到当没有依赖 */
  }
  cache.set(key, { at: Date.now(), parent: parent });
  return parent;
}

/**
 * 在给定 id 集合内建依赖索引。
 * @returns {{ parentOf: Object, childrenOf: Object }}
 */
function buildIndex(wsDir, ids, childrenMap) {
  const parentOf = {};
  const childrenOf = {};
  (ids || []).forEach((raw) => {
    const id = String(raw);
    const parent = readDependency(wsDir, id);
    // 依赖来源两处（与父项目一致）：本地 project.json 的 dependency + Steam 详情里的 children
    const fromChildren = (childrenMap && childrenMap[id]) || [];
    fromChildren.forEach((childId) => {
      const c = String(childId);
      (childrenOf[id] = childrenOf[id] || []).push(c);
      parentOf[c] = id;
    });
    if (!parent) return;
    parentOf[id] = parent;
    (childrenOf[parent] = childrenOf[parent] || []).push(id);
  });
  return { parentOf: parentOf, childrenOf: childrenOf };
}

/** 某个壁纸的依赖链（向上，返回 [父, 祖父, …]，已去重、按就近优先） */
function dependencyChain(wsDir, id, maxDepth) {
  const out = [];
  const seen = new Set([String(id)]);
  let cur = String(id);
  for (let i = 0; i < (maxDepth || 8); i++) {
    const parent = readDependency(wsDir, cur);
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    out.push(parent);
    cur = parent;
  }
  return out;
}

/** 依赖它的子孙（向下，含间接；返回顺序 = 先子后孙，方便按这个顺序退订） */
function dependentList(index, id) {
  const out = [];
  const seen = new Set([String(id)]);
  const queue = (index.childrenOf[String(id)] || []).slice();
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    (index.childrenOf[cur] || []).forEach((c) => queue.push(c));
  }
  return out;
}

function clearCache() {
  cache.clear();
}

module.exports = { readDependency, buildIndex, dependencyChain, dependentList, clearCache };
