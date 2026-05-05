/**
 * OrgDebugHelper.gs — 組織成員清單診斷工具
 * 職責：從執行項目輸出 org member list 的後端抓取流程與缺漏原因
 *
 * 使用方式：
 * 1. 在 Apps Script Editor 選擇 testOrgMemberListCEO()
 * 2. 執行後到「執行項目」查看 Logger.log 輸出
 */

/**
 * 無參數測試入口：診斷 CEO 節點。
 */
function testOrgMemberListCEO() {
  debugOrgMemberListByCode_('CEO');
}

/**
 * 通用診斷器：輸出指定 orgCode 的組織樹與成員清單計算過程。
 *
 * @param {string} orgCode
 */
function debugOrgMemberListByCode_(orgCode) {
  const startedAt = new Date();
  Logger.log('========== [OrgMember Debug Start] ==========');
  Logger.log('Input orgCode: ' + String(orgCode || ''));
  Logger.log('Timestamp: ' + startedAt.toISOString());

  if (!orgCode) {
    Logger.log('[ERROR] 缺少 orgCode，停止診斷');
    Logger.log('========== [OrgMember Debug End] ==========');
    return;
  }

  try {
    const orgData = DataService.getSheet2Data(null);
    const analysis = analyzeOrgGraph(orgData);
    const org = analysis.nodesByCode.get(orgCode);

    logOrgDebugSummary_(orgCode, orgData, analysis, org);
    if (!org) {
      Logger.log('[ERROR] 找不到對應組織節點：' + orgCode);
      Logger.log('========== [OrgMember Debug End] ==========');
      return;
    }

    const subtreeCodes = analysis.descendantsByCode.get(orgCode) || new Set([orgCode]);
    const assignments = DataService.getAllAssignments()
      .filter(item => subtreeCodes.has(item.orgCode));
    const assignmentsByOrgCode = buildAssignmentsByOrgCodeMap_(assignments);
    const sections = buildOrgMemberSections_(orgCode, analysis, assignments);

    logSubtreeCodes_(orgCode, subtreeCodes, analysis);
    logGraphWarnings_(analysis.warnings, subtreeCodes);
    logMatchedAssignments_(assignments);
    logSectionResults_(sections);
    logManagerCoverage_(analysis, subtreeCodes, assignmentsByOrgCode);

    Logger.log(
      '[SUCCESS] 診斷完成：org=' + orgCode +
      ', subtreeNodes=' + subtreeCodes.size +
      ', matchedAssignments=' + assignments.length +
      ', sections=' + sections.length
    );
  } catch (error) {
    Logger.log('[ERROR] debugOrgMemberListByCode_ 發生例外：' + (error.stack || error.message));
  }

  Logger.log('========== [OrgMember Debug End] ==========');
}

function logOrgDebugSummary_(orgCode, orgData, analysis, org) {
  Logger.log(
    '[SUMMARY] orgData rows=' + orgData.length +
    ', rootNodes=' + analysis.rootCodes.length +
    ', warnings=' + analysis.warnings.length +
    ', cycles=' + analysis.cycles.length
  );

  if (!org) return;

  Logger.log(
    '[NODE] code=' + org.code +
    ', name=' + (org.name || '') +
    ', level=' + String(org.level || '') +
    ', parentCode=' + (org.parentCode || '') +
    ', managerEmail=' + (org.managerEmail || '') +
    ', managerName=' + (org.managerName || '')
  );

  const directChildren = analysis.safeChildrenMap.get(orgCode) || [];
  Logger.log('[NODE] directChildren(' + directChildren.length + ')=' + (directChildren.join(', ') || '(none)'));
}

function logSubtreeCodes_(orgCode, subtreeCodes, analysis) {
  const ordered = [];
  walkOrgSubtree_(orgCode, analysis, 0, (node, depth) => {
    ordered.push(`${'  '.repeat(depth)}- ${node.code} | ${node.name || ''} | level=${node.level} | parent=${node.parentCode || ''}`);
  });

  Logger.log('[SUBTREE] total=' + subtreeCodes.size);
  ordered.forEach(line => Logger.log(line));
}

function logGraphWarnings_(warnings, subtreeCodes) {
  const relevant = warnings.filter(item => subtreeCodes.has(item.code) || subtreeCodes.has(item.parentCode));
  if (relevant.length === 0) {
    Logger.log('[WARNINGS] none');
    return;
  }

  Logger.log('[WARNINGS] count=' + relevant.length);
  relevant.forEach((item, idx) => {
    Logger.log(
      '[WARNINGS][' + (idx + 1) + '] type=' + (item.type || '') +
      ' code=' + (item.code || '') +
      ' parent=' + (item.parentCode || '') +
      ' message=' + (item.message || '')
    );
  });
}

function logMatchedAssignments_(assignments) {
  Logger.log('[ASSIGNMENTS] matched=' + assignments.length);
  if (assignments.length === 0) {
    Logger.log('[ASSIGNMENTS] none');
    return;
  }

  assignments.forEach((item, idx) => {
    Logger.log(
      '[ASSIGNMENTS][' + (idx + 1) + '] email=' + (item.email || '') +
      ' | name=' + (item.name || '') +
      ' | orgCode=' + (item.orgCode || '') +
      ' | title=' + (item.title || '') +
      ' | managerEmail=' + (item.managerEmail || '') +
      ' | managerName=' + (item.managerName || '') +
      ' | rowIndex=' + String(item.rowIndex || '')
    );
  });
}

function logSectionResults_(sections) {
  Logger.log('[SECTIONS] count=' + sections.length);
  if (sections.length === 0) {
    Logger.log('[SECTIONS] none');
    return;
  }

  sections.forEach((section, idx) => {
    Logger.log(
      '[SECTIONS][' + (idx + 1) + '] orgCode=' + (section.orgCode || '') +
      ' | orgName=' + (section.orgName || '') +
      ' | depth=' + String(section.depthFromSelected || 0) +
      ' | level=' + String(section.level || '') +
      ' | assignments=' + (section.assignments || []).length
    );
  });
}

function logManagerCoverage_(analysis, subtreeCodes, assignmentsByOrgCode) {
  Logger.log('[MANAGER COVERAGE] start');

  Array.from(subtreeCodes).forEach(code => {
    const node = analysis.nodesByCode.get(code);
    if (!node) return;

    const orgAssignments = assignmentsByOrgCode.get(code) || [];
    const memberEmails = orgAssignments.map(item => String(item.email || ''));
    const managerEmail = String(node.managerEmail || '');
    const managerMatched = !!managerEmail && memberEmails.includes(managerEmail);

    Logger.log(
      '[ORG CHECK] code=' + code +
      ' | name=' + (node.name || '') +
      ' | sheet2.manager=' + (node.managerName || '(none)') +
      ' (' + (managerEmail || '(none)') + ')' +
      ' | sheet3.memberCount=' + orgAssignments.length +
      ' | matchedInSameSection=' + (managerMatched ? 'YES' : 'NO')
    );

    if (orgAssignments.length > 0) {
      Logger.log(
        '[ORG CHECK] sectionMembers=' +
        orgAssignments.map(item => `${item.name || item.email} <${item.email || ''}> [${item.orgCode || ''}]`).join(' ; ')
      );
    } else {
      Logger.log('[ORG CHECK] sectionMembers=(none)');
    }

    if (managerEmail && !managerMatched) {
      const managerAssignments = DataService.getSheet3DataByEmail(managerEmail);
      Logger.log(
        '[MISSING_MANAGER_IN_SECTION] code=' + code +
        ' | manager=' + (node.managerName || '') +
        ' (' + managerEmail + ')' +
        ' | managerAssignments=' +
        (managerAssignments.length
          ? managerAssignments.map(item => `${item.orgCode}:${item.title || ''}`).join(' ; ')
          : '(none in Sheet3)')
      );
    }
  });
}

function buildAssignmentsByOrgCodeMap_(assignments) {
  const map = new Map();
  assignments.forEach(item => {
    const code = item.orgCode || '';
    if (!map.has(code)) map.set(code, []);
    map.get(code).push(item);
  });
  return map;
}
