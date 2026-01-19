const path = require('path');
const XLSX = require('xlsx'); // xlsx kütüphanesi
const storageService = require('../services/storageService');
const n8nService = require('../services/n8nService');

exports.convertPackingList = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "Lütfen bir dosya yükleyin" });
        }

        console.log("🚀 İşlem Başlıyor (Hermes - CSV Modu)...");
        const originalName = req.file.originalname;

        // 1. Dosyayı CDN'e yükle
        const inputCdnUrl = await storageService.uploadToCDN(req.file.buffer, originalName);

        // 2. n8n'e gönder ve CSV Buffer sonucunu al
        const n8nResponseBuffer = await n8nService.processFileWithN8N(inputCdnUrl);

        console.log("3. CSV okunuyor ve Excel formatlaması yapılıyor...");

        // A) CSV Buffer'ı Workbook olarak oku
        // raw: true -> Excel'in otomatik sayı çevirme (date parsing vb.) özelliklerini kapatır.
        const workbook = XLSX.read(n8nResponseBuffer, { type: 'buffer', raw: true });

        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];

        // B) Hücre Tiplerini Manuel Zorla
        // CSV'de veri tipleri olmaz, hepsi "değer"dir. Biz burada tipleri atayacağız.
        // Sütunlar: A: PALLET, B: ITEM, C: DESC, D: QTY

        if (worksheet['!ref']) {
            const range = XLSX.utils.decode_range(worksheet['!ref']);

            const palletColIndex = 0;   // A Sütunu
            const itemColIndex = 1;     // B Sütunu
            const quantityColIndex = 3; // D Sütunu

            // Satırları gez (Başlık hariç: range.s.r + 1)
            for (let R = range.s.r + 1; R <= range.e.r; ++R) {

                // 1. PALLET_NUMBER (A Sütunu) -> Kesinlikle STRING
                const palletAddr = XLSX.utils.encode_cell({ c: palletColIndex, r: R });
                if (worksheet[palletAddr]) {
                    worksheet[palletAddr].t = 's'; // Type: String (Metin)
                    worksheet[palletAddr].v = String(worksheet[palletAddr].v).trim();
                }

                // 2. ITEM_NUMBER (B Sütunu) -> Kesinlikle STRING
                const itemAddr = XLSX.utils.encode_cell({ c: itemColIndex, r: R });
                if (worksheet[itemAddr]) {
                    worksheet[itemAddr].t = 's'; // Type: String (Metin)
                    worksheet[itemAddr].v = String(worksheet[itemAddr].v).trim();
                }

                // 3. DELIVERY_QUANTITY (D Sütunu) -> Kesinlikle NUMBER
                const qtyAddr = XLSX.utils.encode_cell({ c: quantityColIndex, r: R });
                if (worksheet[qtyAddr]) {
                    // Temizlik: "1,050" gibi metin gelirse temizle
                    const rawVal = worksheet[qtyAddr].v;
                    const cleanVal = String(rawVal).replace(/[^0-9.]/g, '');

                    if (cleanVal !== "" && !isNaN(cleanVal)) {
                        worksheet[qtyAddr].t = 'n'; // Type: Number (Sayı)
                        worksheet[qtyAddr].v = Number(cleanVal);
                    }
                }
            }
        }

        // C) Excel (XLSX) Buffer'ı oluştur
        const xlsxBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

        const outputFileName = `${path.parse(originalName).name}_hermes_analyzed.xlsx`;
        console.log(`4. Sonuç dosyası (${outputFileName}) BunnyCDN'e yükleniyor...`);

        const outputCdnUrl = await storageService.uploadToCDN(xlsxBuffer, outputFileName);

        console.log("-> İşlem Tamam! Excel Linki:", outputCdnUrl);

        res.status(200).json({
            success: true,
            message: "Hermes CSV dönüşümü başarılı",
            input_url: inputCdnUrl,
            xlsx_url: outputCdnUrl,
            file_name: outputFileName
        });

    } catch (error) {
        console.error("❌ Controller Hatası:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
};