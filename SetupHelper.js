/**
 * SetupHelper.gs — 初始化工具
 * 職責：首次部署時建立五張工作表的欄位結構與操作日誌表
 * 
 * 使用方式：
 * 1. 在 GAS Script Editor 選擇 setupSheets()
 * 2. 點擊「執行」
 * 3. 確認 Spreadsheet 中已出現正確欄位標題
 * 
 * ⚠ 此函式僅需執行一次。若工作表已存在欄位，會跳過建立。
 */

/**
 * 主要初始化函式
 * 依序建立所有工作表並設定標題列
 */
function setupSheets() {
  const ss = getSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  // 安全確認
  const response = ui.alert(
    '⚠ 確認初始化',
    '此操作將建立系統所需的工作表結構。\n若工作表已存在正確標題，將跳過。\n\n確認繼續？',
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;

  const sheetConfigs = [
    {
      name:    SHEET_NAMES.PERSONNEL,
      headers: ['信箱', '姓名', '員工狀態'],
      note:    'Sheet 1：人員主檔 — 信箱為主鍵（Primary Key）',
    },
    {
      name:    SHEET_NAMES.ORG,
      headers: ['組織類型', '層級', '代碼', '名稱', '別名', '上級代碼', '管理人員信箱', '管理人員姓名'],
      note:    'Sheet 2：組織架構樹 — 代碼為主鍵，上級代碼自我關聯',
    },
    {
      name:    SHEET_NAMES.ASSIGNMENT,
      headers: ['信箱', '姓名', '所屬組別代碼', '所屬組別', '職稱', '主管信箱', '直屬主管'],
      note:    'Sheet 3：人員職務配置 — 一人可有多列（兼任）',
    },
    {
      name:    SHEET_NAMES.RACI,
      headers: ['任務代碼', '任務名稱', '工作項目代碼', '工作項目名稱', 'R (執行)', 'A (當責)', 'C (諮詢)', 'I (告知)', '備註'],
      note:    'Sheet 4：RACI 矩陣主表 — R/A/C/I 填寫角色代碼（ROLE-*）',
    },
    {
      name:    SHEET_NAMES.ROLE_MAP,
      headers: ['角色代碼', '角色名稱', '對應實體類型', '對應實體ID/說明'],
      note:    'Sheet 5：RACI 角色對照表 — 類型支援 PERSON / GROUP / RULE / EXTERNAL；同一角色代碼可多列綁定不同實體',
    },
    {
      name:    SHEET_NAMES.AUDIT_LOG,
      headers: ['時間戳', '操作者Email', '操作類型', '操作對象', '異動摘要'],
      note:    '操作日誌：所有 CRUD 操作自動寫入，請勿手動修改',
    },
  ];

  const results = sheetConfigs.map(config => initSheet(ss, config));
  applySheetFormatting(ss);

  const summary = results.map(r => `${r.name}：${r.action}`).join('\n');
  ui.alert('✅ 初始化完成', summary, ui.ButtonSet.OK);
  Logger.log('setupSheets 完成：\n' + summary);
}

/**
 * 初始化單一工作表
 * 若不存在則建立；若存在但無標題則寫入；若已有標題則跳過
 * 
 * @param {Spreadsheet} ss
 * @param {{name, headers, note}} config
 * @returns {{name, action}}
 */
function initSheet(ss, config) {
  let sheet = ss.getSheetByName(config.name);

  if (!sheet) {
    sheet = ss.insertSheet(config.name);
    Logger.log(`建立工作表：${config.name}`);
  }

  const firstRow = sheet.getRange(1, 1, 1, config.headers.length).getValues()[0];
  const alreadySetup = firstRow.some(v => v !== '');

  if (alreadySetup) {
    return { name: config.name, action: '已存在標題，跳過' };
  }

  // 寫入標題列
  sheet.getRange(1, 1, 1, config.headers.length).setValues([config.headers]);

  // 設定標題欄備註
  if (config.note) {
    sheet.getRange(1, 1).setNote(config.note);
  }

  return { name: config.name, action: '已建立標題列' };
}

/**
 * 套用統一格式：標題列凍結、字型加粗、背景色
 * 
 * @param {Spreadsheet} ss
 */
function applySheetFormatting(ss) {
  const allSheetNames = Object.values(SHEET_NAMES);

  allSheetNames.forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;

    // 凍結標題列
    sheet.setFrozenRows(1);

    // 標題列樣式
    const headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 1);
    headerRange.setBackground('#1a73e8')
               .setFontColor('#ffffff')
               .setFontWeight('bold')
               .setHorizontalAlignment('center');

    // 自動調整欄寬
    sheet.autoResizeColumns(1, sheet.getLastColumn() || 1);
  });
}

// =============================================
// 測試資料注入（開發用，生產環境請勿執行）
// =============================================

/**
 * 注入最小可用測試資料集
 * ⚠ 僅供開發測試，生產環境請刪除此函式或確認不執行
 */
function injectSampleData_DEV_ONLY() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    '⚠ 開發模式',
    '此函式將注入測試資料，覆蓋現有內容。\n\n僅限開發環境使用。確認繼續？',
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;

  // Sheet 2：組織架構樹
  const orgSheet = getSheet(SHEET_NAMES.ORG);
  const orgData = [
    ['ORG', 1, 'ORG-ROOT',    '組織代表人',  '',       '',          'e001@example.org', '王代表'],
    ['ORG', 2, 'ORG-EXEC',    '執行長室',    '',       'ORG-ROOT',  'e002@example.org', '李執行長'],
    ['ORG', 3, 'DEPT-BIO',    '生醫部',      '',       'ORG-EXEC',  'e003@example.org', '張生醫部長'],
    ['ORG', 3, 'DEPT-INFO',   '資訊部',      '',       'ORG-EXEC',  'e004@example.org', '陳資訊部長'],
    ['ORG', 3, 'DEPT-ADMIN',  '行政部',      '策略辦公室', 'ORG-EXEC', 'e005@example.org', '林行政部長'],
    ['ORG', 4, 'GRP-ADMIN',   '行政支援組',  '',       'DEPT-ADMIN','e005@example.org', '林行政部長'],
    ['ORG', 4, 'GRP-INFO',    '資訊組',      '',       'DEPT-INFO', 'e004@example.org', '陳資訊部長'],
    ['ORG', 4, 'GRP-REC',     '收案組',      '',       'DEPT-BIO',  'e003@example.org', '張生醫部長'],
    ['TF',  2, 'TF-COMM',     '資安個資管理委員會', '', '',         'e001@example.org', '王代表'],
    ['TF',  3, 'TF-GRP-SEC',  '資安執行小組', '',      'TF-COMM',   'e004@example.org', '陳資訊部長'],
    ['TF',  3, 'TF-GRP-PIMS', '個資管理執行小組', '',  'TF-COMM',   'e003@example.org', '張生醫部長'],
    ['TF',  3, 'TF-GRP-AUDIT','內部稽核執行小組', '',  'TF-COMM',   'e005@example.org', '林行政部長'],
    ['PARTNER', 3, 'PARTNER-SYS', '系統開發外包廠商', '', '', '', ''],
    ['GOV',     3, 'GOV-AUTH',    '個資監管機關',     '', '', '', ''],
  ];
  orgSheet.getRange(2, 1, orgData.length, widthFromColMap(COL.ORG)).setValues(orgData);

  // Sheet 1：人員主檔
  const personnelSheet = getSheet(SHEET_NAMES.PERSONNEL);
  const personnelData = [
    ['e001@example.org', '王代表',   'ORG-ROOT',   '組織代表人'],
    ['e002@example.org', '李執行長', 'ORG-EXEC',   '執行長室'],
    ['e003@example.org', '張生醫部長','DEPT-BIO',  '生醫部'],
    ['e004@example.org', '陳資訊部長','DEPT-INFO', '資訊部'],
    ['e005@example.org', '林行政部長','DEPT-ADMIN','行政部'],
    ['e006@example.org', '小明',      'GRP-REC',   '收案組'],
    ['e007@example.org', '小華',      'GRP-INFO',  '資訊組'],
  ];
  personnelSheet.getRange(2, 1, personnelData.length, widthFromColMap(COL.PERSONNEL)).setValues(personnelData);

  // Sheet 3：人員職務配置
  const assignSheet = getSheet(SHEET_NAMES.ASSIGNMENT);
  const assignData = [
    ['e001@example.org', '王代表',   'ORG-ROOT',   '組織代表人', '代表人',         '', ''],
    ['e002@example.org', '李執行長', 'ORG-EXEC',   '執行長室',   '執行長',         'e001@example.org', '王代表'],
    ['e003@example.org', '張生醫部長','DEPT-BIO',  '生醫部',    '生醫部長',        'e002@example.org', '李執行長'],
    ['e003@example.org', '張生醫部長','TF-COMM',   '資安個資管理委員會','個資管理執行小組組長','e001@example.org','王代表'],
    ['e004@example.org', '陳資訊部長','DEPT-INFO', '資訊部',    '資訊部長',        'e002@example.org', '李執行長'],
    ['e005@example.org', '林行政部長','DEPT-ADMIN','行政部',    '行政部長（策略長）','e002@example.org','李執行長'],
    ['e005@example.org', '林行政部長','TF-COMM',   '資安個資管理委員會','資訊安全長','e001@example.org','王代表'],
    ['e005@example.org', '林行政部長','TF-GRP-AUDIT','內部稽核執行小組','稽核小組組長','e001@example.org','王代表'],
    ['e006@example.org', '小明',      'GRP-REC',   '收案組',    '駐站管理員',      'e003@example.org', '張生醫部長'],
    ['e007@example.org', '小華',      'GRP-INFO',  '資訊組',    '系統管理師',      'e004@example.org', '陳資訊部長'],
  ];
  assignSheet.getRange(2, 1, assignData.length, widthFromColMap(COL.ASSIGNMENT)).setValues(assignData);

  // Sheet 5：角色對照表（部分）
  const roleSheet = getSheet(SHEET_NAMES.ROLE_MAP);
  const roleData = [
    ['ROLE-CONVENER',     '召集人',       'PERSON', 'e001@example.org'],
    ['ROLE-CISO',         '資訊安全長',   'PERSON', 'e005@example.org'],
    ['ROLE-ISWG-LEAD',    '資安小組組長', 'PERSON', 'e004@example.org'],
    ['ROLE-PIMS-LEAD',    '個資小組組長', 'PERSON', 'e003@example.org'],
    ['ROLE-AUDIT-LEAD',   '稽核小組組長', 'PERSON', 'e005@example.org'],
    ['ROLE-PROCESS-OWNER','業務承辦人',   'RULE',   'ALL'],
    ['ROLE-SYS-ADMIN',    '系統管理人員', 'GROUP',  'GRP-INFO'],
    ['ROLE-AUDITOR',      '稽核員',       'GROUP',  'TF-GRP-AUDIT'],
    ['ROLE-UNIT-HEAD',    '單位主管',     'RULE',   'Level=3'],
  ];
  roleSheet.getRange(2, 1, roleData.length, widthFromColMap(COL.ROLE_MAP)).setValues(roleData);

  ui.alert('✅ 測試資料注入完成', '已注入人員、組織、職務配置、角色對照表基礎資料。', ui.ButtonSet.OK);
}

// =============================================
// 操作日誌工作表初始化（確保欄位存在）
// =============================================

/**
 * 確保操作日誌工作表存在（由寫入日誌前呼叫）
 * 若不存在則自動建立
 */
function ensureAuditLogSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAMES.AUDIT_LOG);
  if (sheet) return;

  sheet = ss.insertSheet(SHEET_NAMES.AUDIT_LOG);
  sheet.getRange(1, 1, 1, widthFromColMap(COL.AUDIT_LOG)).setValues([['時間戳', '操作者Email', '操作類型', '操作對象', '異動摘要']]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, widthFromColMap(COL.AUDIT_LOG))
       .setBackground('#34495e')
       .setFontColor('#ffffff')
       .setFontWeight('bold');
}
