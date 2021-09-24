var str = ($response.body);

str = str.match(/:&#x2f;&#x2f;(\S*)"}/)[1].replace(/&#x2f;/g, '/').replace(/&amp;/g, '&').split("\"")[0]
let opener = str.indexOf("m.tb.cn") != -1 ? "taobao://" + str: ($response.body)
//console.log(str);

const $ = new cmp()

if (str.indexOf("m.tb.cn") != -1) {
    $.notify(``, "", "🛍️点击打开淘宝", opener)
} else if (str.indexOf("如需浏览")) {
    $.notify(``,"", "🔗点击打开链接", "https://"+str)
}

$done({body: $response.body});

function cmp() {
    this.notify = (title, subtitle, message, url) => {
         $notify(title, subtitle, message, { "open-url": url })
    }
}
