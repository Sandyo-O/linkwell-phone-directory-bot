# 資料處理程式碼

這裡是把「分機表.zip」(9個地區的組織圖式Excel檔)轉成 `voice/directory.json` 和 `分機查詢小幫手.yml` 用的程式碼。平常不需要用到,只有總機更新了新的分機表.xlsx、需要重新整理資料時才需要跑。

## 已知的重要bug(2026-09-08修好)

`extract-all.js` 原本的Excel儲存格解析regex有bug:當一個空白儲存格(`<c .../>`,自我封閉的標籤)後面緊接著一個有內容的儲存格時,regex會錯誤地把兩者「黏」在一起,導致：

1. 後面那個儲存格的值,被誤植到前面空白儲存格的欄位去(欄位錯位)
2. 中間那個儲存格整個被跳過、消失

這造成好幾筆同仁的部門顯示錯誤(例如「鄭美麗」被誤植成「金融研發二部」,實際上應該是「金融研發三部」),也讓一些人的分機資料整筆遺失(修好後,總筆數從1206筆增加到1321筆)。

修法是把儲存格比對的regex改成**先比對自我封閉的空白標籤**,再比對正常的開合標籤,避免正常標籤的比對範圍「跨過」空白標籤去吃到下一個儲存格。詳細註解寫在 `extract-all.js` 的 `parseSheet` function裡。

**如果之後重新整理資料,發現有人的部門/分機看起來不對,這類「儲存格錯位」的bug是優先要排查的方向**——尤其如果錯的人剛好前面有一個空欄位。

## 怎麼重新整理資料(總機給新的分機表.xlsx時)

```bash
# 1. 解壓縮新的 分機表.zip,並且把每個地區的.xlsx各自解壓縮成資料夾
#    (extract-all.js 讀的是解壓縮後的 xlsx 內部 XML,不是直接讀 .xlsx 檔)
mkdir allxlsx
for f in 分機表/*.xlsx; do
  base=$(basename "$f" .xlsx)
  mkdir -p "allxlsx/$base"
  unzip -o "$f" -d "allxlsx/$base"
done

# 2. 跑萃取程式,產生 consolidated.csv 和 directory.json
node extract-all.js allxlsx
cp directory.json ../voice/directory.json
cp consolidated.csv "../分機資料庫(整理後).csv"

# 3. 重新產生內嵌1321筆資料的 Dify DSL yml 檔
node gen-dsl.js
```

跑完之後記得:
- 到Dify裡刪掉舊app、用新的 `分機查詢小幫手.yml` 重新匯入(環境變數要重新設定一次)
- 檢查一下資料品質(有沒有新的部門/分機錯位情況),尤其是抽查幾個真人資料庫紀錄
