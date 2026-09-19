# Classroom Game Center v1

這是 GitHub Pages 靜態版管理中心，已填入 classroom-game-center 的 Firebase Web 設定。

## 目前功能
- Google 登入管理中心
- 登入後顯示 Firebase UID
- 管理員權限確認
- 建立房間：遊戲、立即/指定開始時間、1/3/6/12/24/27/48 小時或自訂到期
- 產生 4 碼房間碼
- 產生學生加入 Token、教師控制 Token
- 產生學生 QR Code
- 複製學生/教師網址
- 延長房間 1/3/6/12/24/27/48 小時
- 立即關閉房間
- join.html：驗證學生通行證並輸入座號的測試入口
- host.html：驗證教師控制通行證的測試入口

## 第一次部署後的流程
1. 將整個資料夾上傳 GitHub Repository，開啟 GitHub Pages。
2. Firebase Console > Authentication > 設定 > Authorized domains，加上 `你的GitHub帳號.github.io`。
3. 開啟 GitHub Pages 管理中心，用你的 Google 帳號登入。
4. 頁面會顯示 Firebase UID。把 UID 提供給 ChatGPT。
5. 再到 Realtime Database 的資料頁手動建立 `admins/<你的UID> = true`，並把 `firebase-rules.template.json` 的規則貼到 Rules 後發布（ChatGPT 會逐步帶你完成）。
6. 重新整理管理中心，房間管理功能就會自動開啟。

## 注意
在 Firebase 仍是 Locked mode 時，Google 登入與 UID 顯示可以工作，但讀寫 Realtime Database 會被拒絕，這是正常現象。
