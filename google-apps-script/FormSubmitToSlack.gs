function onFormSubmit(e) {
  var sheet = e.range.getSheet();
  var row = e.range.getRow();
  sendSlackForRow_(sheet, row);
}

// HÀM CHÍNH: nhận sheet + row, build message và gửi Slack (form mượn thiết bị)
function sendSlackForRow_(sheet, row) {
  var webhookUrl = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!webhookUrl) throw new Error('Missing SLACK_WEBHOOK_URL');

  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var values = sheet.getRange(row, 1, row, lastCol).getDisplayValues()[0];

  var data = {};
  for (var i = 0; i < headers.length; i++) {
    data[String(headers[i] || '').trim()] = String(values[i] || '').trim();
  }

  var tenThietBi = data['Tên Thiết Bị'] || '—';
  var lyDoSuDung = data['Lý do sử dụng (Link Ticket)'] || '—';
  var nguoiSuDung = data['Người Sử Dụng'] || '—';
  var ngayNhan = data['Ngày Nhận'] || '—';
  var ngayTra = data['Ngày Trả'] || '—';
  var ghiChu = data['Ghi Chú'] || '—';

  var ticketText = !lyDoSuDung || lyDoSuDung === '—'
    ? '—'
    : (/^https?:\/\//i.test(lyDoSuDung) ? '<' + lyDoSuDung + '|Link ticket>' : escapeMrkdwn(lyDoSuDung));
  var body =
    escapeMrkdwn(nguoiSuDung) + ' đăng ký mượn thiết bị ' + escapeMrkdwn(tenThietBi) + '.\n' +
    'Ticket: ' + ticketText + '\n' +
    'Ngày nhận: ' + escapeMrkdwn(ngayNhan) + '\n' +
    'Ngày trả: ' + escapeMrkdwn(ngayTra) + '\n' +
    'Ghi chú: ' + escapeMrkdwn(ghiChu);

  var formUrl = 'https://forms.gle/PzHtPB5soTkR9Yb78';

  var ss = sheet.getParent();
  var baseUrl = ss.getUrl();
  var sheetId = sheet.getSheetId();
  var rangeA1 = 'A' + row + ':Z' + row;
  var rowUrl = baseUrl.replace(/edit$/, '') + 'edit#gid=' + sheetId + '&range=' + encodeURIComponent(rangeA1);

  var blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Thông báo mượn thiết bị', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: body,
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '<' + rowUrl + '|Xem dòng ' + row + ' trong sheet> · Đăng ký mượn mới tại: <' + formUrl + '|Form đăng ký>',
        },
      ],
    },
  ];

  var payload = JSON.stringify({
    text: 'Thông báo mượn thiết bị',
    blocks: blocks,
  });

  UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: payload,
    muteHttpExceptions: true,
  });
}

function escapeMrkdwn(s) {
  return String(s || '').replace(/[&<>]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
  });
}
