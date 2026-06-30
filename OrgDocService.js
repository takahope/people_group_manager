/**
 * OrgDocService.gs — 組織成員表文件生成服務
 *
 * 依固定格式的 Google Doc 範本，將後端人事資料（組織架構樹 + 人員職務配置 + 人員主檔）
 * 填入範本表格，於 Drive 產生一份填好的 Google Doc。
 *
 * 範本：example/TWHB-ISMSPIMS-004-002資訊安全暨個人資料管理組織成員表V2.1（模板）.docx
 *   - 表格固定 6 欄：職務 / 職稱 / 姓名 / 電話 / 手機 / 電子郵件
 *   - 「職務」欄已預填角色標籤（召集人 / 資訊安全長兼任資料保護長 / 組長 / 組員）
 *   - 本服務只填入後 5 欄；格式完全沿用範本
 *
 * 設定（Script Properties，於 Apps Script 編輯器手動設定）：
 *   - ISMS_ORG_DOC_TEMPLATE_ID      範本 Google Doc 檔案 ID
 *   - ISMS_ORG_DOC_OUTPUT_FOLDER_ID 輸出 Drive 資料夾 ID
 *
 * 跨層慣例：資料存取一律走 DataService，回傳 Plain Object。
 */

const ISMS_DOC_PROPS = {
  TEMPLATE_ID: 'ISMS_ORG_DOC_TEMPLATE_ID',
  OUTPUT_FOLDER_ID: 'ISMS_ORG_DOC_OUTPUT_FOLDER_ID',
  RECORD_PREFIX: 'ISMS_ORG_DOC_RECORD_PREFIX',
};

/** 紀錄編號前綴預設值（未於 Script Properties 設定 RECORD_PREFIX 時採用）。 */
const ISMS_RECORD_PREFIX_DEFAULT = 'TWHB-ISMSPIMS-004-002';

/**
 * 範本 6 區塊宣告式設定（依「組織名稱」自動比對組織節點，含別名容錯）。
 * kind=committee：委員會（召集人 + 資訊安全長兼任資料保護長）
 * kind=group   ：執行/稽核/應變小組（組長 + 組員 N）
 */
// orgCode：用「組別代碼」直接查組織節點（最穩，避開中文名稱比對落差）。
// matchNames：僅供「範本群組標題列（中文固定文字）→ 區塊」比對使用。
const ISMS_TEMPLATE_SECTIONS = [
  { key: 'committee', kind: 'committee', orgCode: 'TF-ISPI-COMM',      matchNames: ['資訊安全暨個人資料保護管理委員會', '資訊安全暨個人資料管理委員會', '資安個資管理委員會'] },
  { key: 'sec',       kind: 'group',     orgCode: 'TF-ISPI-GRP-SEC',   matchNames: ['資訊安全執行小組', '資安執行小組'] },
  { key: 'pims',      kind: 'group',     orgCode: 'TF-ISPI-GRP-PIMS',  matchNames: ['個人資料管理執行小組', '個資管理執行小組'] },
  { key: 'audit',     kind: 'group',     orgCode: 'TF-ISPI-GRP-AUDIT', matchNames: ['內部稽核執行小組'] },
  { key: 'emergency', kind: 'group',     orgCode: 'TF-ISPI-GRP-EMER',  matchNames: ['緊急應變處理小組'] },
];

/** 範本字型（標楷體），填值後套用以保留範本字型。 */
const ISMS_DOC_FONT = 'DFKai-SB';

/** 除錯日誌開關：true 時於生成流程輸出資料與表格結構至 Logger（排查完可改回 false）。 */
const ISMS_DEBUG = true;

/** 受 ISMS_DEBUG 控制的日誌輸出。 */
function ismsLog_(msg) {
  if (ISMS_DEBUG) Logger.log('[ISMS] ' + msg);
}

// =============================================
// 資料蒐集
// =============================================

/**
 * 蒐集 6 區塊成員資料（依組織名稱比對 → 取成員 → 補電話/手機 → 角色分類）。
 *
 * @returns {Object} sectionsByKey，key 為區塊代碼，值為
 *   { convener, ciso, leader, members:[] }，每個成員為
 *   { title, name, phone, mobile, email } 或 null。
 */
function buildIsmsOrgMemberData_() {
  // 三張表各預載一次、全部改記憶體查表（避免每人整表讀取造成生成時間暴增）
  const personByEmail = {};
  DataService.getSheet1Data().forEach(function (p) { personByEmail[p.email] = p; });
  const orgByCode = {};
  DataService.getSheet2Data().forEach(function (o) { orgByCode[o.code] = o; });
  const assignsByEmail = {};
  const allAssign = DataService.getAllAssignments();
  allAssign.forEach(function (a) { (assignsByEmail[a.email] = assignsByEmail[a.email] || []).push(a); });
  const ctx = { personByEmail: personByEmail, orgByCode: orgByCode, assignsByEmail: assignsByEmail };

  const result = {};

  ISMS_TEMPLATE_SECTIONS.forEach(function (section) {
    const node = orgByCode[section.orgCode];   // 用組別代碼直接查節點（記憶體）
    const slot = { convener: null, ciso: null, leader: null, members: [] };

    if (node) {
      const enriched = allAssign.filter(function (a) { return a.orgCode === node.code; }).map(function (a) {
        const person = ctx.personByEmail[a.email] || {};
        return {
          roleTitle: a.title || '',                                // 該區塊 E 欄職稱 → 用於 WHO 比對
          title:     resolveDisplayTitle_(a.email, a.title, ctx),  // 顯示「職稱」(行政層級最高 D/E，退回 E)
          name:      a.name || person.name || '',
          email:     a.email || '',
          phone:     person.phone || '',
          mobile:    person.mobile || '',
        };
      });

      const used = new Array(enriched.length).fill(false);
      const pick = function (predicate) {
        for (let i = 0; i < enriched.length; i++) {
          if (!used[i] && predicate(enriched[i])) { used[i] = true; return enriched[i]; }
        }
        return null;
      };

      if (section.kind === 'committee') {
        // 委員會純用 TF-ISPI-COMM 的 E 欄比對（不套管理人後備，避免搶人導致資安長列空白）
        slot.convener = pick(function (e) { return /召集人/.test(e.roleTitle); });
        slot.ciso = pick(function (e) { return /資訊安全長/.test(e.roleTitle) || /資料保護長/.test(e.roleTitle); });
      } else {
        // 小組純用 E 欄比對組長（不套管理人後備）
        slot.leader = pick(function (e) { return /組長/.test(e.roleTitle); });
      }
      slot.members = enriched.filter(function (e, i) { return !used[i]; });
    }

    result[section.key] = slot;

    // 除錯：印出此區塊用 orgCode 抓到的節點與成員樣態
    ismsLog_('區塊 ' + section.key + ' / orgCode=' + section.orgCode +
      ' nodeFound=' + (!!node) + (node ? ' nodeCode=' + node.code + ' nodeName=' + node.name : '') +
      ' convener=' + (slot.convener && slot.convener.name) +
      ' ciso=' + (slot.ciso && slot.ciso.name) +
      ' leader=' + (slot.leader && slot.leader.name) +
      ' members=' + JSON.stringify((slot.members || []).map(function (m) { return (m.roleTitle || '') + ':' + (m.name || ''); })));
  });

  return result;
}

/**
 * 是否為「行政」類型組織節點（正式資料中文值 / demo 代碼皆相容）。
 * @param {string} type
 * @returns {boolean}
 */
function isAdminOrgType_(type) {
  return type === '行政' || type === 'ORG';
}

/**
 * 表格「職稱」欄取值：掃描此人在「行政」類型節點中層級最高（COL.ORG.LEVEL 數字最小）者，
 * 回該人在此節點職務配置的「所屬組別(D)/職稱(E)」；D 與 E 相同時只回 E。
 * 找不到行政類型職務時退回 fallbackTitle（該區塊職務配置 E 欄）。
 *
 * @param {string} email
 * @param {string} fallbackTitle
 * @param {{ assignsByEmail: Object, orgByCode: Object }} ctx - 預載索引（記憶體查表）
 * @returns {string}
 */
function resolveDisplayTitle_(email, fallbackTitle, ctx) {
  const assigns = (ctx && ctx.assignsByEmail[email]) || [];
  let best = null;
  let bestLevel = Infinity;
  let bestIsLeader = false;
  assigns.forEach(function (a) {
    const node = ctx.orgByCode[a.orgCode];
    if (!node || !isAdminOrgType_(node.type)) return;
    const lvl = Number(node.level);
    if (isNaN(lvl)) return;
    const isLeader = /組長|副組長/.test(a.title || '');   // 同組別多列時，組長/副組長優先
    if (lvl < bestLevel || (lvl === bestLevel && isLeader && !bestIsLeader)) {
      best = a; bestLevel = lvl; bestIsLeader = isLeader;
    }
  });
  if (best) {
    const dept = best.orgName || '';   // D 所屬組別
    const title = best.title || '';    // E 職稱
    return (dept && dept !== title) ? (dept + '/' + title) : title;
  }
  return fallbackTitle || '';
}

// =============================================
// 文件生成
// =============================================

/**
 * 複製範本 Doc、填入資料、存入輸出資料夾，回傳連結。
 *
 * @param {Object} sectionsByKey - buildIsmsOrgMemberData_() 的結果
 * @returns {{ url, fileId, fileName, recordNo }}
 */
function renderIsmsOrgMemberDoc_(sectionsByKey) {
  const props = PropertiesService.getScriptProperties();
  const templateId = (props.getProperty(ISMS_DOC_PROPS.TEMPLATE_ID) || '').trim();
  const folderId = (props.getProperty(ISMS_DOC_PROPS.OUTPUT_FOLDER_ID) || '').trim();

  // 缺值時附上「store 內目前實際存在的 key 清單」，便於一眼比對鍵名落差（只列 key，不洩漏值）
  const presentKeys = props.getKeys();
  if (!templateId) {
    throw new Error('尚未設定範本 Doc ID（需要 key：' + ISMS_DOC_PROPS.TEMPLATE_ID +
      '）。目前 Script Properties 內的 key：[' + presentKeys.join(', ') + ']');
  }
  if (!folderId) {
    throw new Error('尚未設定輸出資料夾 ID（需要 key：' + ISMS_DOC_PROPS.OUTPUT_FOLDER_ID +
      '）。目前 Script Properties 內的 key：[' + presentKeys.join(', ') + ']');
  }

  // 日期與紀錄編號（紀錄編號需在 makeCopy 前算好，掃描須早於新檔建立）
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  // 紀錄編號用的日期鍵：西元年只取後兩位（例 260630 → 2026/06/30）
  const dateKey = Utilities.formatDate(now, tz, 'yyMMdd');
  const year = Utilities.formatDate(now, tz, 'yyyy');
  const month = Utilities.formatDate(now, tz, 'MM');
  const day = Utilities.formatDate(now, tz, 'dd');

  const prefix = (props.getProperty(ISMS_DOC_PROPS.RECORD_PREFIX) || '').trim() || ISMS_RECORD_PREFIX_DEFAULT;
  const outputFolder = DriveApp.getFolderById(folderId);
  const recordNo = createRecordNoFromFolder_(outputFolder, prefix, dateKey);

  const fileName = 'TWHB-ISMSPIMS-004-002資訊安全暨個人資料管理組織成員表_' + recordNo;
  const copiedFile = DriveApp.getFileById(templateId).makeCopy(fileName, outputFolder);

  const doc = DocumentApp.openById(copiedFile.getId());

  // 置換首頁（頁首）佔位符：{{年}}/{{月}}/{{日}}/{{紀錄編號}}
  replaceTemplateTokens_(doc, { '年': year, '月': month, '日': day, '紀錄編號': recordNo });

  const tables = doc.getBody().getTables();
  if (!tables.length) {
    throw new Error('範本中找不到表格，請確認範本 Doc ID 是否正確。');
  }

  fillIsmsTable_(tables[0], sectionsByKey);

  doc.saveAndClose();
  return { url: doc.getUrl(), fileId: copiedFile.getId(), fileName: fileName, recordNo: recordNo };
}

/**
 * 轉義正則表示式特殊字元。
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp_(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 依輸出資料夾現有檔案產生當日不重複紀錄編號：{前綴}-{yyyyMMdd}-{NN}。
 * 掃描資料夾中檔名含 `前綴-dateKey-(數字)` 者取最大流水號 +1，<100 補兩位數。
 *
 * @param {Folder} folder
 * @param {string} prefix
 * @param {string} dateKey - yyyyMMdd
 * @returns {string}
 */
function createRecordNoFromFolder_(folder, prefix, dateKey) {
  const pattern = new RegExp(escapeRegExp_(prefix) + '-' + dateKey + '-(\\d+)');
  let maxSerial = 0;
  const files = folder.getFiles();
  while (files.hasNext()) {
    const name = String(files.next().getName() || '').trim();
    const match = name.match(pattern);
    if (!match) continue;
    const serial = parseInt(match[1], 10);
    if (!isNaN(serial) && serial > maxSerial) maxSerial = serial;
  }
  const nextSerial = maxSerial + 1;
  const serialText = nextSerial < 100 ? ('0' + nextSerial).slice(-2) : String(nextSerial);
  return prefix + '-' + dateKey + '-' + serialText;
}

/**
 * 置換文件所有區塊（正文/頁首/頁尾）的 {{佔位符}}，支援前後空白寫法。
 * 完全保留佔位符原本的字型/大小/顏色。
 *
 * @param {Document} doc
 * @param {Object} tokenMap - { 佔位符名稱: 置換值 }
 */
function replaceTemplateTokens_(doc, tokenMap) {
  const sections = [doc.getBody(), doc.getHeader(), doc.getFooter()].filter(Boolean);
  Object.keys(tokenMap || {}).forEach(function (key) {
    const pattern = '\\{\\{\\s*' + escapeRegExp_(key) + '\\s*\\}\\}';
    sections.forEach(function (section) {
      section.replaceText(pattern, String(tokenMap[key]));
    });
  });
}

/**
 * 走訪範本表格，依「職務」標籤與群組標題列把成員填入後 5 欄。
 * 組員多於範本既有列時自動補列；少於則留空。
 *
 * @param {Table} table
 * @param {Object} sectionsByKey
 */
function fillIsmsTable_(table, sectionsByKey) {
  // 除錯：印出範本表格每列結構（cells / 是否被判為標題 / 順序對應區塊 / 文字比對 / 第0欄文字）
  if (ISMS_DEBUG) {
    ismsLog_('表格列數=' + table.getNumRows());
    let dbgIdx = -1;
    for (let r = 0; r < table.getNumRows(); r++) {
      const dr = table.getRow(r);
      const col0 = dr.getCell(0).getText().trim();
      const isH = isSectionHeaderRow_(dr, r);
      if (isH) dbgIdx++;
      const mapped = isH && dbgIdx < ISMS_TEMPLATE_SECTIONS.length ? ISMS_TEMPLATE_SECTIONS[dbgIdx].key : '';
      ismsLog_('R' + r + ' cells=' + dr.getNumCells() + ' header=' + isH +
        ' 順序對應=' + mapped + ' matchKey=' + matchSectionKey_(col0) + ' col0=' + JSON.stringify(col0));
    }
  }

  // ── 第一輪：掃描各區塊的「組員」列數，計算需補幾列 ──
  // 區塊標題列「依出現順序」對應 ISMS_TEMPLATE_SECTIONS，不靠中文標題文字反查，
  // 避免某區塊標題文字對不上導致區塊路由斷裂、內容外溢到下一區。
  const memberRowsByKey = {};
  let scanIdx = -1;
  let curKey = null;
  for (let r = 0; r < table.getNumRows(); r++) {
    const row = table.getRow(r);
    if (isSectionHeaderRow_(row, r)) {
      scanIdx++;
      curKey = scanIdx < ISMS_TEMPLATE_SECTIONS.length ? ISMS_TEMPLATE_SECTIONS[scanIdx].key : null;
      continue;
    }
    if (curKey && row.getCell(0).getText().trim() === '組員') {
      (memberRowsByKey[curKey] = memberRowsByKey[curKey] || []).push(r);
    }
  }

  // ── 補列：自下而上插入，避免索引位移 ──
  const inserts = [];
  Object.keys(memberRowsByKey).forEach(function (key) {
    const slots = memberRowsByKey[key].length;
    const need = (sectionsByKey[key] && sectionsByKey[key].members.length) || 0;
    if (need > slots) {
      inserts.push({ afterIdx: memberRowsByKey[key][slots - 1], count: need - slots });
    }
  });
  inserts.sort(function (a, b) { return b.afterIdx - a.afterIdx; });
  inserts.forEach(function (ins) {
    const templateRow = table.getRow(ins.afterIdx);
    for (let k = 0; k < ins.count; k++) {
      table.insertTableRow(ins.afterIdx + 1, templateRow.copy());
    }
  });

  // ── 第二輪：填值（同樣依出現順序對應區塊）──
  let fillIdx = -1;
  let key = null;
  let memberIdx = 0;
  for (let r = 0; r < table.getNumRows(); r++) {
    const row = table.getRow(r);
    if (isSectionHeaderRow_(row, r)) {
      fillIdx++;
      key = fillIdx < ISMS_TEMPLATE_SECTIONS.length ? ISMS_TEMPLATE_SECTIONS[fillIdx].key : null;
      memberIdx = 0;
      continue;
    }
    const sec = key && sectionsByKey[key];
    if (!sec) continue;

    const label = row.getCell(0).getText().trim();
    if (label === '召集人') {
      fillIsmsRow_(row, sec.convener);
    } else if (label.indexOf('資訊安全長') >= 0 || label.indexOf('資料保護長') >= 0) {
      fillIsmsRow_(row, sec.ciso);
    } else if (label === '組長') {
      fillIsmsRow_(row, sec.leader, true);          // 小組職務欄改填實際 E 值
    } else if (label === '組員') {
      fillIsmsRow_(row, sec.members[memberIdx], true);
      memberIdx++;
    }
  }

  // ── 委員會：把召集人/資安長以外的其餘成員，逐筆插入為新列（職務＝該人 E 欄）──
  const committee = sectionsByKey.committee;
  if (committee && committee.members && committee.members.length) {
    appendCommitteeMembers_(table, committee.members);
  }
}

/**
 * 在委員會區塊末端插入「其他委員會成員」列：職務欄填該人 E 欄職稱，其餘 5 欄填資料。
 * 在填值走訪完成後呼叫，避免與既有列的標籤比對衝突。
 *
 * @param {Table} table
 * @param {Array<Object>} members - 每筆 { roleTitle, title, name, phone, mobile, email }
 */
function appendCommitteeMembers_(table, members) {
  // 委員會＝第 1 個標題列；其結束位置＝第 2 個標題列（下一區）。依順序偵測，不靠文字。
  let headerIdx = -1;
  let endIdx = table.getNumRows();
  for (let r = 0; r < table.getNumRows(); r++) {
    if (!isSectionHeaderRow_(table.getRow(r), r)) continue;
    if (headerIdx < 0) { headerIdx = r; }
    else { endIdx = r; break; }
  }
  if (headerIdx < 0) return;
  if (endIdx - 1 <= headerIdx) return;          // 無資料列可當格式範本

  const templateRow = table.getRow(endIdx - 1); // 委員會最後一筆資料列（資安長列）作為格式範本
  members.forEach(function (m, i) {
    const newRow = table.insertTableRow(endIdx + i, templateRow.copy());
    fillIsmsRow_(newRow, m, true);                // 職務(E)＋職稱/姓名/電話/手機/Email
  });
}

/**
 * 把一筆成員資料填入該列的「職稱/姓名/電話/手機/電子郵件」（cell 1~5）。
 * person 為 null/undefined 時留空。
 * setRole 為 true 且有 person 時，職務欄（cell 0）改填該人 E 欄職稱（roleTitle）。
 *
 * @param {TableRow} row
 * @param {Object|null} person - { roleTitle, title, name, phone, mobile, email }
 * @param {boolean} [setRole] - 是否把職務欄改填實際 E 值
 */
function fillIsmsRow_(row, person, setRole) {
  if (setRole && person) {
    const c0 = row.getCell(0).editAsText();
    c0.setText(person.roleTitle || '');
    if (person.roleTitle) c0.setFontFamily(ISMS_DOC_FONT);
  }

  const values = person
    ? [person.title || '', person.name || '', person.phone || '', person.mobile || '', person.email || '']
    : ['', '', '', '', ''];

  for (let c = 1; c <= 5; c++) {
    if (c >= row.getNumCells()) break;
    const text = row.getCell(c).editAsText();
    text.setText(values[c - 1]);
    if (values[c - 1]) text.setFontFamily(ISMS_DOC_FONT);
  }
}

/**
 * 是否為「區塊標題列」。先用文字命中 matchSectionKey_；對不上時，
 * 退而求其次以「合併成單一儲存格的列」判定（範本群組標題列即如此），
 * 讓區塊路由不受個別標題中文文字落差影響。
 *
 * @param {TableRow} row
 * @param {number} rowIndex
 * @returns {boolean}
 */
function isSectionHeaderRow_(row, rowIndex) {
  const col0 = row.getCell(0).getText().trim();
  if (matchSectionKey_(col0)) return true;
  return rowIndex > 0 && row.getNumCells() <= 1 && col0 !== '';
}

/**
 * 依群組標題列文字比對出區塊代碼（先精確、再包含）。
 *
 * @param {string} headerText
 * @returns {string|null}
 */
function matchSectionKey_(headerText) {
  if (!headerText) return null;
  const exact = ISMS_TEMPLATE_SECTIONS.find(function (s) {
    return s.matchNames.indexOf(headerText) >= 0;
  });
  if (exact) return exact.key;
  const partial = ISMS_TEMPLATE_SECTIONS.find(function (s) {
    return s.matchNames.some(function (n) { return headerText.indexOf(n) >= 0 || n.indexOf(headerText) >= 0; });
  });
  return partial ? partial.key : null;
}

// =============================================
// 診斷工具（供開發者於 Apps Script 編輯器手動執行）
// =============================================

/**
 * 診斷 Script Properties 設定。
 * 用法：於 Apps Script 編輯器函式下拉選 diagnoseIsmsDocConfig → Run，
 * 至「執行項目／執行記錄」查看 Logger.log 輸出，比對鍵名是否正確存在。
 */
function diagnoseIsmsDocConfig() {
  const props = PropertiesService.getScriptProperties();
  const keys = props.getKeys();
  Logger.log('========== [ISMS Doc Config Diagnose] ==========');
  Logger.log('全部 Script Property keys（共 ' + keys.length + '）：' + JSON.stringify(keys));
  [ISMS_DOC_PROPS.TEMPLATE_ID, ISMS_DOC_PROPS.OUTPUT_FOLDER_ID].forEach(function (k) {
    const v = props.getProperty(k);
    Logger.log('[' + k + '] 存在=' + (v != null) + '，長度=' + (v ? v.length : 0) +
      '，trim 後長度=' + (v ? v.trim().length : 0));
  });
  // 反向揪出隱形空白／全形空白的可疑鍵名
  keys.forEach(function (k) {
    if (k !== k.trim() || /[　]/.test(k)) {
      Logger.log('[疑似異常鍵] 原始=' + JSON.stringify(k) + '（含前後空白或全形空白）');
    }
  });
  Logger.log('================================================');
}

/**
 * 診斷範本表格結構與各區塊抓到的資料。
 * 用法：於 Apps Script 編輯器選 diagnoseIsmsDocTemplate → Run，看「執行記錄」。
 * 逐列印出 [列索引, getNumCells, 是否被判為標題列, matchSectionKey 結果, 第0欄文字]，
 * 以及各區塊（依 orgCode）找到的節點與成員，便於定位區塊路由/資料問題。
 */
function diagnoseIsmsDocTemplate() {
  Logger.log('========== [ISMS Doc Template Diagnose] ==========');
  const props = PropertiesService.getScriptProperties();
  const templateId = (props.getProperty(ISMS_DOC_PROPS.TEMPLATE_ID) || '').trim();
  if (!templateId) { Logger.log('未設定範本 Doc ID'); return; }

  const tables = DocumentApp.openById(templateId).getBody().getTables();
  if (!tables.length) { Logger.log('範本中找不到表格'); return; }
  const table = tables[0];
  let idx = -1;
  for (let r = 0; r < table.getNumRows(); r++) {
    const row = table.getRow(r);
    const col0 = row.getCell(0).getText().trim();
    const isHeader = isSectionHeaderRow_(row, r);
    if (isHeader) idx++;
    const mappedKey = isHeader && idx < ISMS_TEMPLATE_SECTIONS.length ? ISMS_TEMPLATE_SECTIONS[idx].key : '';
    Logger.log('R' + r + ' cells=' + row.getNumCells() + ' header=' + isHeader +
      ' 順序對應=' + mappedKey + ' matchKey=' + matchSectionKey_(col0) + ' col0=' + JSON.stringify(col0));
  }

  const data = buildIsmsOrgMemberData_();
  ISMS_TEMPLATE_SECTIONS.forEach(function (s) {
    const slot = data[s.key] || {};
    const members = (slot.members || []).map(function (m) { return (m.roleTitle || '') + ':' + (m.name || ''); });
    Logger.log('[' + s.key + '/' + s.orgCode + '] convener=' + (slot.convener && slot.convener.name) +
      ' ciso=' + (slot.ciso && slot.ciso.name) + ' leader=' + (slot.leader && slot.leader.name) +
      ' members=' + JSON.stringify(members));
  });
  Logger.log('================================================');
}

// =============================================
// Namespace（供 OrgAPI 跨檔呼叫）
// =============================================

const OrgDocService = {
  buildIsmsOrgMemberData: buildIsmsOrgMemberData_,
  renderToDoc: renderIsmsOrgMemberDoc_,
};
