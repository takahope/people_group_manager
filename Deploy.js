/**
 * Deploy.gs — HR 管理系統部署工具
 *
 * 提供兩支公開函式：
 *   deploySheets()            → 僅建立工作表結構與欄位標題（不寫入資料）
 *   deployWithSampleData()    → 建立工作表結構 + 注入完整測試資料
 *
 * 設計原則：
 *  - 兩支函式共用同一個「結構建立」流程，避免重複程式碼（高內聚）
 *  - 所有資料以常數陣列集中定義，方便日後維護（單一資料源）
 *  - Guard Clause：工作表已存在且已有標題時，跳過建立步驟，不覆蓋資料
 *  - 所有操作完成後以 SpreadsheetApp.flush() 確保寫入
 */

// ============================================================
// 0. 共用常數
// ============================================================

/**
 * 六張工作表的名稱、欄位標題、欄位說明（滑鼠移上去顯示）
 * 修改欄位時只需修改此處，下方資料注入函式會自動對應
 */
const SHEET_SCHEMA = [
  {
    name: '人員主檔',
    headers: ['信箱', '姓名', '資訊資產邏輯分組代號', '資訊資產邏輯分組名稱'],
    notes:   [
      'Primary Key：全系統唯一，格式須符合 email 規範',
      '員工中文全名',
      'FK → 組織架構樹.代碼；資訊資產歸屬查詢用',
      '冗餘欄，提高可讀性',
    ],
    headerColor: '#1a73e8',
  },
  {
    name: '組織架構樹',
    headers: ['組織類型', '層級', '代碼', '名稱', '別名', '上級代碼', '管理人員信箱', '管理人員姓名'],
    notes:   [
      'ORG / TF / PARTNER / GOV',
      '1=代表人 2=執行長 3=部門 4=組別 5=駐站',
      'Primary Key（如 DEPT-BIO）',
      '組織正式名稱',
      '同實體的第二名稱（選填）',
      'FK → 組織架構樹.代碼（自我關聯）；根節點留空',
      'FK → 人員主檔.信箱；垂直兼任者填此欄即可，不需在職務配置重複新增',
      '冗餘欄，提高可讀性',
    ],
    headerColor: '#0f9d58',
  },
  {
    name: '人員職務配置',
    headers: ['信箱', '姓名', '所屬組別代碼', '所屬組別', '職稱', '主管信箱', '直屬主管'],
    notes:   [
      'FK → 人員主檔.信箱',
      '冗餘欄',
      'FK → 組織架構樹.代碼',
      '冗餘欄',
      '在本筆所屬組別中的正式職稱',
      'FK → 人員主檔.信箱；矩陣兼任時不同列可有不同主管',
      '冗餘欄',
    ],
    headerColor: '#e37400',
  },
  {
    name: 'RACI矩陣主表',
    headers: ['任務代碼', '任務名稱', '工作項目代碼', '工作項目名稱', 'R (執行)', 'A (當責)', 'C (諮詢)', 'I (告知)', '備註'],
    notes:   [
      '任務分類代碼（ISMS-DOC / ISMS-RISK / PIMS-OP …）',
      '任務中文名稱',
      '文件編號（如 ISMS-004-009）',
      '文件中文全名',
      'FK → RACI角色對照表.角色代碼；多角色以逗號分隔',
      'FK → RACI角色對照表.角色代碼；ISO 規定每項僅限一個當責角色',
      'FK → RACI角色對照表.角色代碼；多角色以逗號分隔（選填）',
      'FK → RACI角色對照表.角色代碼；多角色以逗號分隔（選填）',
      '補充說明',
    ],
    headerColor: '#d93025',
  },
  {
    name: 'RACI角色對照表',
    headers: ['角色代碼', '角色名稱', '對應實體類型', '對應實體ID/說明'],
    notes:   [
      'Primary Key（如 ROLE-CISO）',
      '角色中文名稱',
      'PERSON / GROUP / RULE / EXTERNAL',
      'PERSON=員工信箱；GROUP=組織代碼；RULE=ALL 或 Level=N；EXTERNAL=合作/機關代碼',
    ],
    headerColor: '#7b1fa2',
  },
  {
    name: '操作日誌',
    headers: ['時間戳', '操作者Email', '操作類型', '操作對象', '異動摘要'],
    notes:   [
      '操作發生時間（由系統自動填入）',
      '執行操作的使用者信箱',
      'ADD / UPDATE / DELETE',
      '被操作的資料描述（如「人員: abc@org」）',
      '異動欄位摘要（JSON 格式）',
    ],
    headerColor: '#455a64',
  },
];

// ============================================================
// 1. 公開函式 A：僅部署工作表結構與欄位
// ============================================================

/**
 * 建立所有工作表與欄位標題，不注入任何資料
 *
 * 適用情境：正式環境首次部署，之後由管理員手動輸入真實資料
 *
 * 執行方式：在 GAS Script Editor 選擇此函式 → 點擊「執行」
 */
function deploySheets() {
  const ui = SpreadsheetApp.getUi();

  const confirm = ui.alert(
    '🚀 確認部署工作表結構',
    '此操作將依規格建立六張工作表（人員主檔、組織架構樹、人員職務配置、\n' +
    'RACI矩陣主表、RACI角色對照表、操作日誌）並設定欄位標題。\n\n' +
    '⚠ 若工作表已存在且已有標題列，將跳過該表，不會覆蓋現有資料。\n\n' +
    '確認繼續？',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) {
    ui.alert('已取消', '部署作業已取消，未做任何變更。', ui.ButtonSet.OK);
    return;
  }

  const results = buildSheetStructure_();
  SpreadsheetApp.flush();

  const summary = results.map(r => `• ${r.name}：${r.action}`).join('\n');
  ui.alert('✅ 工作表結構部署完成', summary, ui.ButtonSet.OK);
  Logger.log('[deploySheets] 完成：\n' + summary);
}

// ============================================================
// 2. 公開函式 B：部署工作表結構 + 注入完整測試資料
// ============================================================

/**
 * 建立所有工作表與欄位標題，並注入完整測試資料
 *
 * 測試資料內容：
 *  - Sheet 1  12 位人員（涵蓋 ADMIN / HR / AUDITOR / MGR / STAFF / EXTERNAL 六種角色）
 *  - Sheet 2  14 個組織節點（行政組織 + 任務編組 + 合作單位 + 外部機關）
 *  - Sheet 3  15 筆職務配置（含矩陣兼任與各權限角色專用測試帳號）
 *  - Sheet 4  51 筆 RACI 矩陣（完整 ISMS + PIMS 工作項目）
 *  - Sheet 5  59 個角色代碼（完整角色對照表）
 *
 * 執行方式：在 GAS Script Editor 選擇此函式 → 點擊「執行」
 */
function deployWithSampleData() {
  const ui = SpreadsheetApp.getUi();

  const confirm = ui.alert(
    '🧪 確認部署工作表結構 + 測試資料',
    '此操作將：\n' +
    '1. 建立六張工作表並設定欄位標題\n' +
    '2. 注入完整測試資料（人員 / 組織 / 職務配置 / RACI / 角色對照表）\n\n' +
    '⚠ 若工作表已存在且已有標題列，該表結構將跳過，但測試資料仍會以 append 方式寫入。\n' +
    '⚠ 建議僅在「全新」或「已清空」的試算表上執行。\n\n' +
    '確認繼續？',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) {
    ui.alert('已取消', '部署作業已取消，未做任何變更。', ui.ButtonSet.OK);
    return;
  }

  // 步驟 1：建立結構
  const structureResults = buildSheetStructure_();

  // 步驟 2：注入測試資料
  injectPersonnel_();
  injectOrgTree_();
  injectAssignments_();
  injectRaciMatrix_();
  injectRoleMap_();

  SpreadsheetApp.flush();

  const structureSummary = structureResults.map(r => `• ${r.name}：${r.action}`).join('\n');
  ui.alert(
    '✅ 部署完成（結構 + 測試資料）',
    structureSummary + '\n\n測試資料已全部注入，請至各工作表確認。',
    ui.ButtonSet.OK
  );
  Logger.log('[deployWithSampleData] 完成');
}

// ============================================================
// 3. 結構建立（共用，Private）
// ============================================================

/**
 * 依 SHEET_SCHEMA 建立所有工作表的標題列與格式
 *
 * 提取為獨立函式，讓兩支公開函式共用，避免程式碼重複
 * @returns {Array<{name, action}>} 每張表的處理結果
 */
function buildSheetStructure_() {
  const ss = getSpreadsheet();
  return SHEET_SCHEMA.map(schema => createOrSkipSheet_(ss, schema));
}

/**
 * 建立單一工作表的結構
 * Guard Clause：若工作表已存在且第一列有資料 → 直接跳過
 *
 * @param {Spreadsheet} ss
 * @param {Object} schema - SHEET_SCHEMA 中的一個元素
 * @returns {{name, action}}
 */
function createOrSkipSheet_(ss, schema) {
  let sheet = ss.getSheetByName(schema.name);
  const isNew = !sheet;

  if (isNew) {
    sheet = ss.insertSheet(schema.name);
  }

  // 若已有標題列，跳過（不覆蓋）
  const existingFirstCell = sheet.getRange(1, 1).getValue();
  if (!isNew && existingFirstCell !== '') {
    return { name: schema.name, action: '已存在標題列，跳過（現有資料保留）' };
  }

  applyHeaderRow_(sheet, schema);
  return { name: schema.name, action: isNew ? '新建工作表並設定標題列' : '空白工作表，已設定標題列' };
}

/**
 * 套用標題列格式（顏色、字型、凍結、備註、欄寬）
 *
 * @param {Sheet}  sheet
 * @param {Object} schema
 */
function applyHeaderRow_(sheet, schema) {
  const colCount = schema.headers.length;
  const headerRange = sheet.getRange(1, 1, 1, colCount);

  // 寫入標題
  headerRange.setValues([schema.headers]);

  // 格式
  headerRange
    .setBackground(schema.headerColor)
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(false);

  // 凍結標題列
  sheet.setFrozenRows(1);

  // 欄位備註（說明用途）
  schema.notes.forEach((note, i) => {
    if (note) sheet.getRange(1, i + 1).setNote(note);
  });

  // 自動調整欄寬（初始值）
  sheet.autoResizeColumns(1, colCount);

  // 列高設為 28px（標題列）
  sheet.setRowHeight(1, 28);
}

// ============================================================
// 4. 測試資料注入（Private）
// ============================================================

// ------------------------------------------------------------
// 4-1  Sheet 1：人員主檔（12 位人員）
// ------------------------------------------------------------

/**
 * 注入人員主檔測試資料
 * 欄位：信箱 | 姓名 | 資訊資產邏輯分組代號 | 資訊資產邏輯分組名稱
 *
 * 角色測試帳號：
 *  - ADMIN    → e002 / e003 / e004 / e005
 *  - HR       → e008
 *  - AUDITOR  → e009
 *  - MGR      → e010
 *  - STAFF    → e006 / e007 / e011
 *  - EXTERNAL → ext.vendor@example.org
 */
function injectPersonnel_() {
  const data = [
    // [信箱,              姓名,         資訊資產邏輯分組代號, 資訊資產邏輯分組名稱]
    ['e001@example.org',        '王代表',         'ORG-ROOT',    '組織代表人'],
    ['e002@example.org',        '李執行長',       'ORG-EXEC',    '執行長室'],
    ['e003@example.org',        '張生醫部長',     'DEPT-BIO',    '生醫部'],
    ['e004@example.org',        '陳資訊部長',     'DEPT-INFO',   '資訊部'],
    ['e005@example.org',        '林行政部長',     'DEPT-ADMIN',  '行政部'],
    ['e006@example.org',        '小明',           'GRP-REC',     '收案組'],
    ['e007@example.org',        '小華',           'GRP-INFO',    '資訊組'],
    ['e008@example.org',        '何人資',         'GRP-ADMIN',   '行政支援組'],
    ['e009@example.org',        '周稽核',         'TF-GRP-AUDIT','內部稽核執行小組'],
    ['e010@example.org',        '吳組長',         'GRP-REC',     '收案組'],
    ['e011@example.org',        '鄭專員',         'GRP-REC',     '收案組'],
    ['ext.vendor@example.org',  '廠商窗口',       'PARTNER-SYS', '系統開發外包廠商'],
  ];
  appendToSheet_('人員主檔', data);
  Logger.log('[inject] 人員主檔：' + data.length + ' 筆');
}

// ------------------------------------------------------------
// 4-2  Sheet 2：組織架構樹（14 個節點）
// ------------------------------------------------------------

/**
 * 注入組織架構樹測試資料
 * 欄位：組織類型 | 層級 | 代碼 | 名稱 | 別名 | 上級代碼 | 管理人員信箱 | 管理人員姓名
 */
function injectOrgTree_() {
  const data = [
    // ── 行政組織（ORG）──────────────────────────────────────
    // [類型,     層級, 代碼,          名稱,               別名,         上級代碼,      管理人員信箱,        管理人員姓名]
    ['ORG', 1, 'ORG-ROOT',    '組織代表人',         '',             '',            'e001@example.org', '王代表'],
    ['ORG', 2, 'ORG-EXEC',    '執行長室',           '',             'ORG-ROOT',    'e002@example.org', '李執行長'],
    ['ORG', 3, 'DEPT-BIO',    '生醫部',             '',             'ORG-EXEC',    'e003@example.org', '張生醫部長'],
    ['ORG', 3, 'DEPT-INFO',   '資訊部',             '',             'ORG-EXEC',    'e004@example.org', '陳資訊部長'],
    ['ORG', 3, 'DEPT-ADMIN',  '行政部',             '策略辦公室',   'ORG-EXEC',    'e005@example.org', '林行政部長'],
    ['ORG', 4, 'GRP-ADMIN',   '行政支援組',         '',             'DEPT-ADMIN',  'e005@example.org', '林行政部長'],
    ['ORG', 4, 'GRP-INFO',    '資訊組',             '',             'DEPT-INFO',   'e004@example.org', '陳資訊部長'],
    ['ORG', 4, 'GRP-REC',     '收案組',             '',             'DEPT-BIO',    'e003@example.org', '張生醫部長'],
    // ── 任務編組（TF）───────────────────────────────────────
    ['TF',  2, 'TF-COMM',     '資安個資管理委員會', '',             '',            'e001@example.org', '王代表'],
    ['TF',  3, 'TF-GRP-SEC',  '資安執行小組',       '',             'TF-COMM',     'e004@example.org', '陳資訊部長'],
    ['TF',  3, 'TF-GRP-PIMS', '個資管理執行小組',   '',             'TF-COMM',     'e003@example.org', '張生醫部長'],
    ['TF',  3, 'TF-GRP-AUDIT','內部稽核執行小組',   '',             'TF-COMM',     'e005@example.org', '林行政部長'],
    // ── 合作單位 / 外部機關─────────────────────────────────
    ['PARTNER', 3, 'PARTNER-SYS',  '系統開發外包廠商', '',           '',            '',                 ''],
    ['GOV',     3, 'GOV-AUTH',     '個資監管機關',     '',           '',            '',                 ''],
  ];
  appendToSheet_('組織架構樹', data);
  Logger.log('[inject] 組織架構樹：' + data.length + ' 筆');
}

// ------------------------------------------------------------
// 4-3  Sheet 3：人員職務配置（15 筆）
// ------------------------------------------------------------

/**
 * 注入人員職務配置測試資料
 * 欄位：信箱 | 姓名 | 所屬組別代碼 | 所屬組別 | 職稱 | 主管信箱 | 直屬主管
 *
 * 設計說明：
 *  - 林行政部長（e005）示範三重矩陣兼任：行政部長 + 資訊安全長 + 稽核小組組長
 *  - 張生醫部長（e003）示範任務編組兼任：生醫部長 + 個資小組組長
 *  - 何人資（e008）/ 周稽核（e009）/ 吳組長（e010）分別對應純 HR / AUDITOR / MGR 測試角色
 *  - 廠商窗口（ext.vendor@example.org）無 Sheet 3 配置，僅靠 email 規則測試 EXTERNAL 權限
 *  - 王代表（e001）為根節點，主管信箱留空
 */
function injectAssignments_() {
  const data = [
    // [信箱,                姓名,           所屬組別代碼,     所屬組別,               職稱,                     主管信箱,            直屬主管]
    ['e001@example.org', '王代表',     'ORG-ROOT',      '組織代表人',           '代表人',                 '',                  ''],
    ['e002@example.org', '李執行長',   'ORG-EXEC',      '執行長室',             '執行長',                 'e001@example.org', '王代表'],
    ['e003@example.org', '張生醫部長', 'DEPT-BIO',      '生醫部',               '生醫部長',               'e002@example.org', '李執行長'],
    ['e003@example.org', '張生醫部長', 'TF-GRP-PIMS',   '個資管理執行小組',     '個資管理執行小組組長',   'e001@example.org', '王代表'],
    ['e004@example.org', '陳資訊部長', 'DEPT-INFO',     '資訊部',               '資訊部長',               'e002@example.org', '李執行長'],
    ['e004@example.org', '陳資訊部長', 'TF-GRP-SEC',    '資安執行小組',         '資訊安全執行小組組長',   'e001@example.org', '王代表'],
    ['e005@example.org', '林行政部長', 'DEPT-ADMIN',    '行政部',               '行政部長（策略長）',     'e002@example.org', '李執行長'],
    ['e005@example.org', '林行政部長', 'TF-COMM',       '資安個資管理委員會',   '資訊安全長',             'e001@example.org', '王代表'],
    ['e005@example.org', '林行政部長', 'TF-GRP-AUDIT',  '內部稽核執行小組',     '內部稽核執行小組組長',   'e001@example.org', '王代表'],
    ['e006@example.org', '小明',       'GRP-REC',       '收案組',               '駐站管理員',             'e003@example.org', '張生醫部長'],
    ['e007@example.org', '小華',       'GRP-INFO',      '資訊組',               '系統管理師',             'e004@example.org', '陳資訊部長'],
    ['e008@example.org', '何人資',     'GRP-ADMIN',     '行政支援組',           'HR 專員',                'e005@example.org', '林行政部長'],
    ['e009@example.org', '周稽核',     'TF-GRP-AUDIT',  '內部稽核執行小組',     '內部稽核員',             'e005@example.org', '林行政部長'],
    ['e010@example.org', '吳組長',     'GRP-REC',       '收案組',               '收案組組長',             'e003@example.org', '張生醫部長'],
    ['e011@example.org', '鄭專員',     'GRP-REC',       '收案組',               '收案專員',               'e010@example.org', '吳組長'],
  ];
  appendToSheet_('人員職務配置', data);
  Logger.log('[inject] 人員職務配置：' + data.length + ' 筆');
}

// ------------------------------------------------------------
// 4-4  Sheet 4：RACI 矩陣主表（51 筆）
// ------------------------------------------------------------

/**
 * 注入 RACI 矩陣主表完整測試資料
 * 欄位：任務代碼 | 任務名稱 | 工作項目代碼 | 工作項目名稱 | R | A | C | I | 備註
 *
 * 資料來源：資安與個資管理系統權責分工表（完整 ISMS + PIMS 51 項）
 * 空值欄位以空字串 '' 表示（原始文件中的 \- 或空格）
 */
function injectRaciMatrix_() {
  // 輔助常數：提高資料可讀性
  const _ = ''; // 空值（C / I 欄無角色時使用）

  const data = [
    // ─── ISMS-DOC 文件與紀錄管理 ────────────────────────────────────────────────────────────────────────────
    // [任務代碼,    任務名稱,         工作項目代碼,          工作項目名稱,                 R,                                        A,                           C,                   I,                            備註]
    ['ISMS-DOC', '文件與紀錄管理', 'ISMS-004-002', '全景分析作業表',             'ROLE-PROCESS-OWNER',             'ROLE-CONVENER',             _,                   'ROLE-INTERESTED-PARTY',      '內外部關注方'],
    ['ISMS-DOC', '文件與紀錄管理', 'ISMS-004-005', '文件調閱申請單',             'ROLE-PROCESS-OWNER',             'ROLE-AUDIT-LEAD',           _,                   'ROLE-APPLICANT-UNIT',        '申請單位簽章'],
    ['ISMS-DOC', '文件與紀錄管理', 'ISMS-004-006', '文件修訂建議表',             'ROLE-PROCESS-OWNER,ROLE-DOC-CTRL','ROLE-CONVENER,ROLE-CISO',  _,                   'ROLE-RELATED-DEPT',          '依文件階層核准'],
    // ─── ISMS-DOC 組織管理 ──────────────────────────────────────────────────────────────────────────────────
    ['ISMS-DOC', '組織管理',       'ISMS-004-002', '資安暨個資組織成員表',       'ROLE-PROCESS-OWNER',             'ROLE-CONVENER',             _,                   _,                            _],
    ['ISMS-DOC', '組織管理',       'ISMS-004-003', '資安暨個資文件一覽表',       'ROLE-PROCESS-OWNER',             'ROLE-ISWG-LEAD',            _,                   _,                            _],
    // ─── ISMS-RISK 風險管理 ─────────────────────────────────────────────────────────────────────────────────
    ['ISMS-RISK','風險管理',       'ISMS-004-009', '資訊資產清冊',               'ROLE-PROCESS-OWNER',             'ROLE-ISWG-LEAD',            _,                   _,                            '審核資產價值'],
    ['ISMS-RISK','風險管理',       'ISMS-004-010', '威脅弱點評估表',             'ROLE-PROCESS-OWNER',             'ROLE-ISWG-LEAD',            'ROLE-PROCESS-OWNER',_,                            '各業務流程權責人'],
    ['ISMS-RISK','風險管理',       'ISMS-004-011', '風險評鑑彙整表',             'ROLE-PROCESS-OWNER',             'ROLE-CISO',                 _,                   _,                            '最終核准'],
    ['ISMS-RISK','風險管理',       'ISMS-004-012', '風險改善與機會實作計畫',     'ROLE-PROCESS-OWNER',             'ROLE-CISO',                 _,                   _,                            '核准改善計畫'],
    // ─── ISMS-SEC 安全管理 ──────────────────────────────────────────────────────────────────────────────────
    ['ISMS-SEC', '安全管理',       'ISMS-004-004', '資訊刪除紀錄表',             'ROLE-HANDLER',                   'ROLE-UNIT-HEAD',            _,                   'ROLE-APPLICANT',             _],
    ['ISMS-SEC', '安全管理',       'ISMS-004-014', '保密切結書',                 'ROLE-SIGNER',                    'ROLE-UNIT-HEAD',            _,                   _,                            _],
    ['ISMS-SEC', '安全管理',       'ISMS-004-016', '人員教育訓練簽到表',         'ROLE-ATTENDEE',                  _,                           _,                   'ROLE-TRAINEE',               _],
    ['ISMS-SEC', '安全管理',       'ISMS-004-020', '人員進出登記表',             'ROLE-VISITOR',                   'ROLE-MGR,ROLE-ISWG-LEAD',  _,                   _,                            _],
    ['ISMS-SEC', '安全管理',       'cDOC-801',     '資訊機房人員進出登記表',     'ROLE-EDITOR',                    'ROLE-ROOM-MGR',             _,                   _,                            '機房管理員審核'],
    ['ISMS-SEC', '安全管理',       'ISMS-004-021', '資訊資產進出及異動紀錄',     'ROLE-APPLICANT',                 'ROLE-ROOM-MGR,ROLE-ISWG-LEAD',_,               'ROLE-APPLICANT-HEAD',        '申請單位主管知會'],
    // ─── ISMS-INC 事件管理 ──────────────────────────────────────────────────────────────────────────────────
    ['ISMS-INC', '事件管理',       'ISMS-004-022', '資訊安全事件通報單',         'ROLE-REPORTER,ROLE-ISWG-MEMBER', 'ROLE-CISO,ROLE-IR-LEAD',   _,                   'ROLE-AFFECTED-HEAD',         '決定是否向上級通報'],
    // ─── ISMS-OPS 系統運維 ──────────────────────────────────────────────────────────────────────────────────
    ['ISMS-OPS', '系統運維',       'ISMS-004-032', '系統變更申請單',             'ROLE-APPLICANT',                 'ROLE-UNIT-HEAD',            _,                   _,                            '權責單位主管'],
    ['ISMS-OPS', '系統運維',       'ISMS-004-033', '系統使用權限管理者名冊',     'ROLE-SYS-ADMIN',                 'ROLE-ISWG-LEAD',            _,                   _,                            _],
    ['ISMS-OPS', '系統運維',       'ISMS-004-034', '權限帳號檢視申請紀錄單',     'ROLE-SYS-ADMIN',                 'ROLE-ISWG-LEAD',            _,                   _,                            _],
    ['ISMS-OPS', '系統運維',       'ISMS-004-035', '備份管制表',                 'ROLE-PROCESS-OWNER',             'ROLE-CISO,ROLE-ISWG-LEAD', _,                   _,                            _],
    ['ISMS-OPS', '系統運維',       'ISMS-004-036', '備份資料測試紀錄單',         'ROLE-SYS-ADMIN',                 'ROLE-ISWG-LEAD',            _,                   _,                            _],
    ['ISMS-OPS', '系統運維',       'ISMS-004-039', '資訊系統管理者帳號異動',     'ROLE-APPLICANT,ROLE-SYS-ADMIN',  'ROLE-APPLICANT-HEAD,ROLE-ISWG-LEAD',_,          _,                            _],
    ['ISMS-OPS', '系統運維',       'ISMS-004-040', '內外部溝通聯繫表',           'ROLE-MAINTAINER',                _,                           'ROLE-EXT-UNIT',     _,                            '維護廠商'],
    ['ISMS-OPS', '系統運維',       'ISMS-004-042', '組態安全管理表',             'ROLE-MAINTAINER',                'ROLE-UNIT-HEAD',            _,                   _,                            _],
    // ─── ISMS-AUDIT 績效評估 ────────────────────────────────────────────────────────────────────────────────
    ['ISMS-AUDIT','績效評估',      'ISMS-004-004', 'ISMS有效性量測表',           'ROLE-MEASURER',                  'ROLE-CISO',                 _,                   _,                            '審核量測結果'],
    // ─── ISMS-BCM 營運持續 ──────────────────────────────────────────────────────────────────────────────────
    ['ISMS-BCM', '營運持續',       'ISMS-004-023', '業務流程衝擊分析表',         'ROLE-PROCESS-OWNER',             'ROLE-CISO,ROLE-ISWG-LEAD', _,                   _,                            _],
    ['ISMS-BCM', '營運持續',       'ISMS-004-025', '營運持續運作計畫演練紀錄',   'ROLE-PROCESS-OWNER',             'ROLE-ISWG-LEAD',            'ROLE-CO-ORGANIZER', _,                            _],
    // ─── ISMS-AUDIT 內部稽核 ────────────────────────────────────────────────────────────────────────────────
    ['ISMS-AUDIT','內部稽核',      'ISMS-004-027', '資訊安全內部稽核報告',       'ROLE-AUDITOR',                   'ROLE-AUDIT-LEAD',           'ROLE-AUDITEE-REP',  _,                            '受核單位代表諮詢'],
    ['ISMS-AUDIT','內部稽核',      'ISMS-004-028', '資訊安全管理內部稽核表',     'ROLE-AUDITOR',                   'ROLE-AUDIT-LEAD',           _,                   _,                            _],
    // ─── ISMS-AUDIT 矯正措施 ────────────────────────────────────────────────────────────────────────────────
    ['ISMS-AUDIT','矯正措施',      'ISMS-004-029', '矯正處理單',                 'ROLE-ISSUER,ROLE-HANDLER',       'ROLE-TRACKER',              _,                   _,                            '追蹤人確認結果'],
    // ─── ISMS-OPS 系統開發 ──────────────────────────────────────────────────────────────────────────────────
    ['ISMS-OPS', '系統開發',       'ISMS-004-044', '開發需求申請單',             'ROLE-PROCESS-OWNER',             'ROLE-REQUEST-HEAD',         _,                   _,                            '需求單位主管'],
    ['ISMS-OPS', '系統開發',       'ISMS-004-045', '系統開發測試紀錄單',         'ROLE-PROCESS-OWNER',             _,                           'ROLE-EXT-UNIT',     _,                            '若涉及委外'],
    ['ISMS-OPS', '系統開發',       'ISMS-004-046', '系統需求測試暨上線紀錄',     'ROLE-PROCESS-OWNER',             'ROLE-PROCESS-HEAD',         _,                   _,                            '雙方主管確認'],
    // ─── PIMS-OP 個資管理 ───────────────────────────────────────────────────────────────────────────────────
    ['PIMS-OP',  '個資管理',       'PIMS-004-001', '受委託者風險評估表',         'ROLE-VENDOR',                    'ROLE-BIZ-HEAD',             _,                   'ROLE-PROCESS-OWNER',         _],
    ['PIMS-OP',  '個資管理',       'PIMS-004-002', '受委託者個資管理狀況評估',   'ROLE-PROCESS-OWNER,ROLE-VENDOR', 'ROLE-UNIT-HEAD',            _,                   'ROLE-VENDOR',                _],
    ['PIMS-OP',  '個資管理',       'PIMS-004-006', '資料項目之遮蔽方式建議',     'ROLE-IT-UNIT',                   'ROLE-UNIT-HEAD',            'ROLE-UNIT-HEAD',    _,                            '技術執行'],
    ['PIMS-OP',  '個資管理',       'PIMS-004-007', '個人資料盤點作業表',         'ROLE-PROCESS-OWNER',             'ROLE-VERIFIER',             _,                   'ROLE-PIMS-WG,ROLE-CISO',     _],
    ['PIMS-OP',  '個資管理',       'PIMS-004-008', '特定目的新增異動申請表',     'ROLE-APPLICANT',                 'ROLE-COMM,ROLE-BIZ-HEAD',  _,                   'ROLE-PIMS-WG',               _],
    ['PIMS-OP',  '個資管理',       'PIMS-004-009', '個人資料特定目的清單',       'ROLE-PROCESS-UNIT',              'ROLE-PIMS-WG',              _,                   'ROLE-CISO',                  _],
    ['PIMS-OP',  '個資管理',       'PIMS-004-010', '個資停止蒐集處理利用申請',   'ROLE-APPLICANT,ROLE-PROCESS-OWNER','ROLE-PIMS-LEAD',          _,                   'ROLE-BIZ-HEAD',              _],
    // ─── PIMS-OP 權利行使 ───────────────────────────────────────────────────────────────────────────────────
    ['PIMS-OP',  '權利行使',       'PIMS-004-011', '當事人權利行使申請表',       'ROLE-APPLICANT,ROLE-WINDOW',     'ROLE-WINDOW-HEAD',          'ROLE-AGENT',        _,                            _],
    ['PIMS-OP',  '權利行使',       'PIMS-004-012', '當事人行使權利委託書',       'ROLE-CLIENT,ROLE-AGENT',         'ROLE-WINDOW',               _,                   'ROLE-DATA-SUBJECT',          '核對身分'],
    ['PIMS-OP',  '權利行使',       'PIMS-004-013', '當事人查詢及閱覽紀錄',       'ROLE-WINDOW',                    'ROLE-WINDOW-HEAD',          _,                   'ROLE-APPLICANT',             _],
    // ─── PIMS-OP 風險管理 ───────────────────────────────────────────────────────────────────────────────────
    ['PIMS-OP',  '風險管理',       'PIMS-004-014', '個人資料風險評鑑表',         'ROLE-PROCESS-OWNER',             'ROLE-PIMS-WG',              _,                   'ROLE-CISO',                  _],
    // ─── PIMS-OP 證據監管 ───────────────────────────────────────────────────────────────────────────────────
    ['PIMS-OP',  '證據監管',       'PIMS-004-015', '個人資料管理證據監管鏈表',   'ROLE-FORENSIC,ROLE-RECORDER',    'ROLE-PIMS-WG',              _,                   'ROLE-CISO',                  _],
    // ─── PIMS-OP 溝通聯繫 ───────────────────────────────────────────────────────────────────────────────────
    ['PIMS-OP',  '溝通聯繫',       'PIMS-004-016', '個人資料管理對外聯繫清單',   'ROLE-INTERNAL-UNIT',             'ROLE-UNIT-HEAD',            _,                   'ROLE-CONTACT',               _],
    // ─── PIMS-OP 事件管理 ───────────────────────────────────────────────────────────────────────────────────
    ['PIMS-OP',  '事件管理',       'PIMS-004-018', '個資侵害事件通報與處理',     'ROLE-REPORTER,ROLE-INVESTIGATOR','ROLE-UNIT-HEAD,ROLE-PIMS-LEAD',_,               'ROLE-ARCHIVIST,ROLE-AUTH',   '監管機關'],
    // ─── PIMS-OP 內部稽核 ───────────────────────────────────────────────────────────────────────────────────
    ['PIMS-OP',  '內部稽核',       'PIMS-004-019', '個人資料管理內部稽核計畫',   'ROLE-AUDIT-LEAD,ROLE-AUDIT-MEMBER','ROLE-CISO',               'ROLE-AUDITEE',      _,                            _],
    ['PIMS-OP',  '內部稽核',       'PIMS-004-020', '個人資料管理內部稽核表',     'ROLE-SELF-EVAL',                 'ROLE-AUDIT-LEAD',           _,                   'ROLE-COMPANION',             _],
    ['PIMS-OP',  '內部稽核',       'PIMS-004-021', '個人資料管理內部稽核報告',   'ROLE-AUDITOR',                   'ROLE-AUDIT-LEAD',           _,                   'ROLE-AUDITEE-REP',           _],
    // ─── PIMS-OP 委外管理 ───────────────────────────────────────────────────────────────────────────────────
    ['PIMS-OP',  '委外管理',       'PIMS-004-022', '委託關係處置程序單',         'ROLE-PROCESS-OWNER,ROLE-IT-UNIT','ROLE-DELEGATE-HEAD',        _,                   'ROLE-DELEGATE-STAFF',        _],
  ];

  appendToSheet_('RACI矩陣主表', data);
  Logger.log('[inject] RACI矩陣主表：' + data.length + ' 筆');
}

// ------------------------------------------------------------
// 4-5  Sheet 5：RACI 角色對照表（59 個角色）
// ------------------------------------------------------------

/**
 * 注入 RACI 角色對照表完整資料
 * 欄位：角色代碼 | 角色名稱 | 對應實體類型 | 對應實體ID/說明
 *
 * 對應實體類型說明：
 *  PERSON   → 對應實體ID 為員工信箱
 *  GROUP    → 對應實體ID 為組別代碼（Sheet 2）
 *  RULE     → 對應實體ID 為動態規則（ALL / Level=N）
 *  EXTERNAL → 對應實體ID 為合作單位或外部機關代碼（Sheet 2）
 */
function injectRoleMap_() {
  const data = [
    // ── 高層領導角色（PERSON 類型）──────────────────────────────────────────────────
    // [角色代碼,                   角色名稱,                   對應實體類型, 對應實體ID/說明]
    ['ROLE-CONVENER',           '召集人',                   'PERSON',    'e001@example.org'],
    ['ROLE-CISO',               '資訊安全長',               'PERSON',    'e005@example.org'],
    ['ROLE-ISWG-LEAD',          '資訊安全執行小組組長',     'PERSON',    'e004@example.org'],
    ['ROLE-PIMS-LEAD',          '個資管理執行小組組長',     'PERSON',    'e003@example.org'],
    ['ROLE-AUDIT-LEAD',         '內部稽核執行小組組長',     'PERSON',    'e005@example.org'],
    ['ROLE-IR-LEAD',            '緊急處理小組組長',         'PERSON',    'e004@example.org'],

    // ── 動態規則角色（RULE 類型）────────────────────────────────────────────────────
    ['ROLE-PROCESS-OWNER',      '業務承辦人／經辦人',       'RULE',      'ALL'],
    ['ROLE-APPLICANT',          '申請人／申請人員',         'RULE',      'ALL'],
    ['ROLE-HANDLER',            '處置人員',                 'RULE',      'ALL'],
    ['ROLE-SIGNER',             '立同意書人',               'RULE',      'ALL'],
    ['ROLE-ATTENDEE',           '出席人員',                 'RULE',      'ALL'],
    ['ROLE-TRAINEE',            '受訓人員',                 'RULE',      'ALL'],
    ['ROLE-VISITOR',            '進入人員',                 'RULE',      'ALL'],
    ['ROLE-EDITOR',             '修訂人員',                 'RULE',      'ALL'],
    ['ROLE-REPORTER',           '通報人',                   'RULE',      'ALL'],
    ['ROLE-MEASURER',           '量測人員',                 'RULE',      'ALL'],
    ['ROLE-INTERESTED-PARTY',   '內外部關注者',             'RULE',      'ALL'],
    ['ROLE-AFFECTED-HEAD',      '被影響單位主管',           'RULE',      'ALL'],
    ['ROLE-AUDITEE-REP',        '受核單位代表',             'RULE',      'ALL'],
    ['ROLE-ISSUER',             '提出人員',                 'RULE',      'ALL'],
    ['ROLE-TRACKER',            '追蹤人',                   'RULE',      'ALL'],
    ['ROLE-FORENSIC',           '現場鑑識人員',             'RULE',      'ALL'],
    ['ROLE-RECORDER',           '攝影記錄人員',             'RULE',      'ALL'],
    ['ROLE-INTERNAL-UNIT',      '內部負責單位',             'RULE',      'ALL'],
    ['ROLE-CONTACT',            '聯繫對象',                 'RULE',      'ALL'],
    ['ROLE-INVESTIGATOR',       '事件調查人員',             'RULE',      'ALL'],
    ['ROLE-ARCHIVIST',          '歸檔人員',                 'RULE',      'ALL'],
    ['ROLE-SELF-EVAL',          '自評人員',                 'RULE',      'ALL'],
    ['ROLE-COMPANION',          '自評陪同人員',             'RULE',      'ALL'],
    ['ROLE-CLIENT',             '委託人',                   'RULE',      'ALL'],
    ['ROLE-AGENT',              '代理人',                   'RULE',      'ALL'],
    ['ROLE-DATA-SUBJECT',       '當事人',                   'RULE',      'ALL'],
    ['ROLE-DELEGATE-STAFF',     '委託單位權責人員',         'RULE',      'ALL'],
    ['ROLE-VENDOR',             '委外服務廠商',             'RULE',      'ALL'],
    ['ROLE-PROCESS-UNIT',       '承辦單位',                 'RULE',      'ALL'],
    ['ROLE-APPLICANT-UNIT',     '申請單位',                 'RULE',      'ALL'],
    ['ROLE-RELATED-DEPT',       '相關部門',                 'RULE',      'ALL'],

    // ── 層級規則角色（RULE Level=N 類型）────────────────────────────────────────────
    ['ROLE-UNIT-HEAD',          '單位主管',                 'RULE',      'Level=3'],
    ['ROLE-REQUEST-HEAD',       '需求單位主管',             'RULE',      'Level=3'],
    ['ROLE-PROCESS-HEAD',       '承辦單位主管',             'RULE',      'Level=3'],
    ['ROLE-BIZ-HEAD',           '業務單位主管',             'RULE',      'Level=3'],
    ['ROLE-VERIFIER',           '確認人員／主管',           'RULE',      'Level=3'],
    ['ROLE-APPLICANT-HEAD',     '申請單位主管',             'RULE',      'Level=3'],
    ['ROLE-WINDOW-HEAD',        '受理窗口單位主管',         'RULE',      'Level=3'],
    ['ROLE-DELEGATE-HEAD',      '委託單位權責主管',         'RULE',      'Level=3'],

    // ── 組別角色（GROUP 類型）───────────────────────────────────────────────────────
    ['ROLE-SYS-ADMIN',          '系統管理人員',             'GROUP',     'GRP-INFO'],
    ['ROLE-DOC-CTRL',           '文管人員',                 'GROUP',     'GRP-ADMIN'],
    ['ROLE-MAINTAINER',         '維護人員',                 'GROUP',     'GRP-INFO'],
    ['ROLE-ROOM-MGR',           '機房管理員',               'GROUP',     'GRP-INFO'],
    ['ROLE-MGR',                '管理人員',                 'GROUP',     'GRP-INFO'],
    ['ROLE-IT-UNIT',            '資訊單位',                 'GROUP',     'GRP-INFO'],
    ['ROLE-AUDITOR',            '稽核員／稽核人員',         'GROUP',     'TF-GRP-AUDIT'],
    ['ROLE-AUDIT-MEMBER',       '稽核組員',                 'GROUP',     'TF-GRP-AUDIT'],
    ['ROLE-AUDITEE',            '受稽單位',                 'GROUP',     'TF-GRP-AUDIT'],
    ['ROLE-ISWG-MEMBER',        '資安執行小組成員',         'GROUP',     'TF-GRP-SEC'],
    ['ROLE-PIMS-WG',            '個資管理執行小組',         'GROUP',     'TF-GRP-PIMS'],
    ['ROLE-COMM',               '資安暨個資委員會',         'GROUP',     'TF-COMM'],
    ['ROLE-WINDOW',             '受理窗口',                 'GROUP',     'GRP-REC'],
    ['ROLE-CO-ORGANIZER',       '協辦單位',                 'GROUP',     'TF-GRP-SEC'],

    // ── 外部角色（EXTERNAL 類型）────────────────────────────────────────────────────
    ['ROLE-EXT-UNIT',           '外部單位／協辦單位',       'EXTERNAL',  'PARTNER-SYS'],
    ['ROLE-AUTH',               '監管機關',                 'EXTERNAL',  'GOV-AUTH'],
  ];

  appendToSheet_('RACI角色對照表', data);
  Logger.log('[inject] RACI角色對照表：' + data.length + ' 筆');
}

// ============================================================
// 5. 底層寫入輔助（Private）
// ============================================================

/**
 * 將資料列 append 到指定工作表（從最後一個有資料的列之後寫入）
 *
 * 使用 setValues 批次寫入，比逐列 appendRow 快約 10 倍
 * Guard Clause：data 為空時直接返回，不進行 Sheets API 呼叫
 *
 * @param {string}        sheetName
 * @param {Array<Array>}  data       - 二維陣列，每個子陣列為一列
 */
function appendToSheet_(sheetName, data) {
  if (!data || data.length === 0) return;

  const sheet = getSheet(sheetName);
  const startRow = sheet.getLastRow() + 1; // 從現有資料後一列開始
  const colCount = data[0].length;

  sheet.getRange(startRow, 1, data.length, colCount).setValues(data);
}
