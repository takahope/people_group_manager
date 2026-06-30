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
const ISMS_TEMPLATE_SECTIONS = [
  { key: 'committee', kind: 'committee', matchNames: ['資訊安全暨個人資料管理委員會', '資安個資管理委員會'] },
  { key: 'sec',       kind: 'group',     matchNames: ['資訊安全執行小組', '資安執行小組'] },
  { key: 'pims',      kind: 'group',     matchNames: ['個人資料管理執行小組', '個資管理執行小組'] },
  { key: 'audit',     kind: 'group',     matchNames: ['內部稽核執行小組'] },
  { key: 'emergency', kind: 'group',     matchNames: ['緊急應變處理小組'] },
];

/** 範本字型（標楷體），填值後套用以保留範本字型。 */
const ISMS_DOC_FONT = 'DFKai-SB';

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
  const allOrg = DataService.getSheet2Data();   // 全部組織節點
  const result = {};

  ISMS_TEMPLATE_SECTIONS.forEach(function (section) {
    const node = findOrgNodeByNames_(allOrg, section.matchNames);
    const slot = { convener: null, ciso: null, leader: null, members: [] };

    if (node) {
      const managerEmail = node.managerEmail || '';
      const enriched = DataService.getSheet3DataByOrgCode(node.code).map(function (a) {
        const person = DataService.findPersonByEmail(a.email) || {};
        return {
          title:  a.title || '',
          name:   a.name || person.name || '',
          email:  a.email || '',
          phone:  person.phone || '',
          mobile: person.mobile || '',
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
        slot.convener = pick(function (e) { return /召集人/.test(e.title); })
                     || pick(function (e) { return e.email && e.email === managerEmail; })
                     || personFromManager_(node);
        slot.ciso = pick(function (e) { return /資訊安全長/.test(e.title) || /資料保護長/.test(e.title); });
      } else {
        slot.leader = pick(function (e) { return /組長/.test(e.title); })
                   || pick(function (e) { return e.email && e.email === managerEmail; })
                   || personFromManager_(node);
      }
      slot.members = enriched.filter(function (e, i) { return !used[i]; });
    }

    result[section.key] = slot;
  });

  return result;
}

/**
 * 由組織節點的「管理人員」建立成員資料（當管理人在該單位無職務配置列時的後備）。
 * 職稱欄取其第一筆職務配置的職稱；電話/手機取自人員主檔。
 *
 * @param {Object} node
 * @returns {Object|null} { title, name, phone, mobile, email }
 */
function personFromManager_(node) {
  if (!node || !node.managerEmail) return null;
  const person = DataService.findPersonByEmail(node.managerEmail) || {};
  const assigns = DataService.getSheet3DataByEmail(node.managerEmail) || [];
  return {
    title:  assigns.length ? (assigns[0].title || '') : '',
    name:   node.managerName || person.name || '',
    email:  node.managerEmail,
    phone:  person.phone || '',
    mobile: person.mobile || '',
  };
}

/**
 * 依名稱清單比對組織節點（先精確比對 name/alias，再退而求其次用包含關係）。
 *
 * @param {Array} allOrg
 * @param {Array<string>} matchNames
 * @returns {Object|null}
 */
function findOrgNodeByNames_(allOrg, matchNames) {
  const exact = allOrg.find(function (o) {
    return matchNames.indexOf(o.name) >= 0 || (o.alias && matchNames.indexOf(o.alias) >= 0);
  });
  if (exact) return exact;
  return allOrg.find(function (o) {
    return matchNames.some(function (n) {
      return (o.name && o.name.indexOf(n) >= 0) || (n.indexOf(o.name) >= 0 && o.name);
    });
  }) || null;
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
  // ── 第一輪：掃描各區塊的「組員」列數，計算需補幾列 ──
  // 群組標題列以「文字命中區塊名稱」判定，避免依賴匯入後的合併儲存格表示法。
  const memberRowsByKey = {};
  let curKey = null;
  for (let r = 0; r < table.getNumRows(); r++) {
    const label = table.getRow(r).getCell(0).getText().trim();
    const headerKey = matchSectionKey_(label);
    if (headerKey) {
      curKey = headerKey;
      continue;
    }
    if (curKey && label === '組員') {
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

  // ── 第二輪：填值 ──
  let key = null;
  let memberIdx = 0;
  for (let r = 0; r < table.getNumRows(); r++) {
    const row = table.getRow(r);
    const label = row.getCell(0).getText().trim();
    const headerKey = matchSectionKey_(label);
    if (headerKey) {
      key = headerKey;
      memberIdx = 0;
      continue;
    }
    const sec = key && sectionsByKey[key];
    if (!sec) continue;

    if (label === '召集人') {
      fillIsmsRow_(row, sec.convener);
    } else if (label.indexOf('資訊安全長') >= 0 || label.indexOf('資料保護長') >= 0) {
      fillIsmsRow_(row, sec.ciso);
    } else if (label === '組長') {
      fillIsmsRow_(row, sec.leader);
    } else if (label === '組員') {
      fillIsmsRow_(row, sec.members[memberIdx]);
      memberIdx++;
    }
  }
}

/**
 * 把一筆成員資料填入該列的「職稱/姓名/電話/手機/電子郵件」（cell 1~5）。
 * person 為 null/undefined 時留空。
 *
 * @param {TableRow} row
 * @param {Object|null} person - { title, name, phone, mobile, email }
 */
function fillIsmsRow_(row, person) {
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

// =============================================
// Namespace（供 OrgAPI 跨檔呼叫）
// =============================================

const OrgDocService = {
  buildIsmsOrgMemberData: buildIsmsOrgMemberData_,
  renderToDoc: renderIsmsOrgMemberDoc_,
};
