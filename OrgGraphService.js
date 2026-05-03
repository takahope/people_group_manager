/**
 * OrgGraphService.gs — 組織結構安全分析輔助
 * 職責：偵測 parentCode 異常、建立安全 children map、輸出循環與警示
 */

/**
 * 分析組織圖，輸出可安全遍歷的結構資訊。
 *
 * @param {Array<{code, parentCode, name}>} orgData
 * @returns {{
 *   nodesByCode: Map<string, Object>,
 *   safeChildrenMap: Map<string, Array<string>>,
 *   descendantsByCode: Map<string, Set<string>>,
 *   rootCodes: Array<string>,
 *   cycles: Array<Array<string>>,
 *   warnings: Array<Object>,
 * }}
 */
function analyzeOrgGraph(orgData) {
  const nodesByCode = new Map();
  const parentByCode = new Map();
  const safeChildrenMap = new Map();
  const warnings = [];
  const cycles = [];
  const cycleKeys = new Set();

  orgData.forEach(node => {
    if (!node || !node.code) return;
    nodesByCode.set(node.code, node);
    parentByCode.set(node.code, node.parentCode || '');
    safeChildrenMap.set(node.code, []);
  });

  const statusByCode = new Map();
  const blockedEdges = new Set();

  nodesByCode.forEach((_, code) => {
    if (statusByCode.get(code) === 'done') return;
    walkParentChain_(code, parentByCode, nodesByCode, statusByCode, blockedEdges, cycles, cycleKeys, warnings);
  });

  const seenEdges = new Set();
  nodesByCode.forEach((node, code) => {
    const parentCode = parentByCode.get(code) || '';
    if (!parentCode) return;

    if (!nodesByCode.has(parentCode)) {
      warnings.push({
        type: 'missing_parent',
        code,
        parentCode,
        message: `組織節點 ${code} 的上層節點 ${parentCode} 不存在，已改以根節點顯示`,
      });
      return;
    }

    const edgeKey = `${parentCode}->${code}`;
    if (blockedEdges.has(edgeKey)) return;
    if (seenEdges.has(edgeKey)) return;
    safeChildrenMap.get(parentCode).push(code);
    seenEdges.add(edgeKey);
  });

  const rootCodes = [];
  nodesByCode.forEach((_, code) => {
    const parentCode = parentByCode.get(code) || '';
    const edgeKey = `${parentCode}->${code}`;
    if (!parentCode || !nodesByCode.has(parentCode) || blockedEdges.has(edgeKey)) {
      rootCodes.push(code);
    }
  });

  const descendantsByCode = buildSafeDescendantsMap_(nodesByCode, safeChildrenMap);

  return {
    nodesByCode,
    safeChildrenMap,
    descendantsByCode,
    rootCodes,
    cycles,
    warnings,
  };
}

function walkParentChain_(startCode, parentByCode, nodesByCode, statusByCode, blockedEdges, cycles, cycleKeys, warnings) {
  const path = [];
  const pathIndex = new Map();
  let current = startCode;

  while (current && nodesByCode.has(current)) {
    if (statusByCode.get(current) === 'done') break;

    if (pathIndex.has(current)) {
      const cyclePath = path.slice(pathIndex.get(current)).concat(current);
      const cycleKey = cyclePath.join('>');
      if (!cycleKeys.has(cycleKey)) {
        cycleKeys.add(cycleKey);
        cycles.push(cyclePath);
      }

      const blockedParent = parentByCode.get(current) || '';
      blockedEdges.add(`${blockedParent}->${current}`);
      warnings.push({
        type: blockedParent === current ? 'self_parent' : 'cycle',
        code: current,
        parentCode: blockedParent,
        path: cyclePath,
        message: blockedParent === current
          ? `組織節點 ${current} 的 parentCode 指向自己，已切斷該關聯`
          : `偵測到組織節點循環：${cyclePath.join(' -> ')}，已切斷 ${current} 的上層關聯`,
      });
      break;
    }

    pathIndex.set(current, path.length);
    path.push(current);
    statusByCode.set(current, 'visiting');
    current = parentByCode.get(current) || '';
  }

  path.forEach(code => statusByCode.set(code, 'done'));
}

function buildSafeDescendantsMap_(nodesByCode, safeChildrenMap) {
  const descendantsByCode = new Map();

  function collect(code) {
    if (descendantsByCode.has(code)) return descendantsByCode.get(code);
    const set = new Set([code]);
    const children = safeChildrenMap.get(code) || [];
    children.forEach(childCode => {
      collect(childCode).forEach(descendantCode => set.add(descendantCode));
    });
    descendantsByCode.set(code, set);
    return set;
  }

  nodesByCode.forEach((_, code) => collect(code));
  return descendantsByCode;
}

/**
 * 根據安全 children map 建立巢狀樹。
 *
 * @param {Array} flatList
 * @returns {{nodes:Array<Object>, warnings:Array<Object>, cycles:Array<Array<string>>}}
 */
function buildSafeOrgTree(flatList) {
  const analysis = analyzeOrgGraph(flatList);
  const treeNodeMap = new Map();

  analysis.nodesByCode.forEach(node => {
    treeNodeMap.set(node.code, { ...node, children: [] });
  });

  analysis.safeChildrenMap.forEach((children, parentCode) => {
    const parentNode = treeNodeMap.get(parentCode);
    if (!parentNode) return;
    children.forEach(childCode => {
      const childNode = treeNodeMap.get(childCode);
      if (childNode) parentNode.children.push(childNode);
    });
  });

  const nodes = analysis.rootCodes
    .map(code => treeNodeMap.get(code))
    .filter(Boolean);

  return {
    nodes,
    warnings: analysis.warnings,
    cycles: analysis.cycles,
  };
}
