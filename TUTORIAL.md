# 部署坦克對戰

跟著這幾步，大約 5 分鐘就能拿到可以分享給朋友的遊戲網址。

## 確認帳單帳戶

Cloud Run 需要一個帳單帳戶（Google AI Pro 附的每月 Cloud 額度也掛在帳單帳戶上）。

如果你還沒有，先打開 [帳單頁面](https://console.cloud.google.com/billing) 建立一個，再回到這裡。已經有的話直接下一步。

## 執行部署

在下方的終端機貼上這行，按 Enter：

```bash
bash deploy.sh
```

如果跳出「授權 Cloud Shell」的視窗，請按「授權」。

腳本會自動完成這些事：

1. 建立一個新專案
2. 連結帳單帳戶
3. 啟用 Cloud Run
4. 建置並部署遊戲

整個過程大約 3～5 分鐘。

## 完成

最後一行綠色的 `https://tank-battle-….run.app` 就是遊戲網址，傳給朋友用手機打開就能玩。

- 沒人玩的時候伺服器會自動休眠、不計費。
- 之後要更新版本，再執行一次 `bash deploy.sh` 即可。
