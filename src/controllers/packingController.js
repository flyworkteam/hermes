const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const xlsx = require('xlsx');

const storageService = require('../services/storageService');

/**
 * Hermes PLV Order PDF metnini kurallara göre JSON formatına dönüştürür.
 */
function parseHermesPackingList(text) {
    const lines = text.split('\n');
    const products = [];

    let currentPalletNo = null;

    // KURAL 1: Gerçek Palet Numarası tespiti (4-5 Rakam + Boşluk + 18 Rakam SSCC Barkodu)
    const palletHeaderRegex = /^\s*(\d{4,5})\s+\d{18}/;

    // KURAL 2 GÜNCELLEMESİ: Baştaki opsiyonel rakamı da (eğer varsa) yakalamak için parantez içine alıyoruz: (\d{3,6})
    const itemRegex = /^\s*(?:(\d{3,6})\s+)?(?:\*\*\*\s+)?([A-Z0-9\-/]{4,15})\s+(.+)$/i;

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const trimmedLine = rawLine.trim();

        if (!trimmedLine) continue;

        // ADIM 1: Satırda 18 haneli barkod var mı? Varsa bu bir Palet başlığıdır.
        const headerMatch = trimmedLine.match(palletHeaderRegex);
        if (headerMatch) {
            currentPalletNo = headerMatch[1];
            continue;
        }

        // ADIM 2: Bu bir Ürün Satırı mı?
        const prodMatch = trimmedLine.match(itemRegex);
        if (prodMatch) {
            let potentialSeq = prodMatch[1]; // Baştaki 3-6 haneli sayı (eğer eşleştiyse)
            let itemNumber = prodMatch[2].toUpperCase();
            let restOfLine = prodMatch[3].trim();

            // --- HAYAT KURTARAN DÜZELTME (SHIFT FIX) ---
            // Eğer regex baştaki 4-5 haneli ürün kodunu (örn: 40945) "sıra numarası" sanıp yuttuysa
            // ve itemNumber olarak açıklamanın ilk kelimesini (örn: POUDRE) aldıysa bunu geri alıyoruz.
            if (potentialSeq && /^[A-Z]+$/.test(itemNumber)) {
                restOfLine = itemNumber + " " + restOfLine; // Kelimeyi description'a geri ver
                itemNumber = potentialSeq; // Asıl item number'ı (40945) yerine koy
            }

            // --- SIKI GÜVENLİK FİLTRELERİ ---

            // FİLTRE 1: KARA LİSTE (Blacklist)
            const blacklist = [
                "ACCOUNTING", "CUSTOMER", "ZONE", "DELIVERY", "PAGE", "PACKING",
                "ORDER", "LOADING", "DOCUMENT", "FORWARDING", "COMPTOIR", "TOTAL",
                "PALLETS", "PACKAGES", "ARCON"
            ];
            if (blacklist.includes(itemNumber)) continue;

            // FİLTRE 2: 00017... ile başlayan "Document Number" değerlerini engeller.
            if (itemNumber.startsWith('00017')) continue;

            // FİLTRE 3: Sadece rakamlardan oluşan kodlarda 7 haneli ve daha uzunsa (Müşteri/Sipariş No) iptal et.
            if (/^\d+$/.test(itemNumber) && itemNumber.length >= 7) continue;

            // ---------------------------------

            // ADIM 3: Açıklama ve Miktarı ayırmak için satırı sağdan sola oku
            const parts = restOfLine.split(/\s+/);
            let numTokens = [];
            let j = parts.length - 1;

            while (j >= 0) {
                const token = parts[j];
                // Sayı formatı (virgüllü, noktalı, tam sayı) VEYA tek bir harf
                if (/^[\d.,]+$/.test(token) || /^[A-Za-z]$/.test(token)) {
                    numTokens.unshift(token);
                    j--;
                } else {
                    break;
                }
            }

            // TEMİZLİK 1: En sondaki 'A' gibi gereksiz harfleri at
            while (numTokens.length > 0 && /^[A-Za-z]$/.test(numTokens[numTokens.length - 1])) {
                numTokens.pop();
            }

            // TEMİZLİK 2: En sondaki '1.60' gibi height verilerini at
            while (numTokens.length > 0 && /^\d+\.\d{2}$/.test(numTokens[numTokens.length - 1])) {
                numTokens.pop();
            }

            // TEMİZLİK 3 (AĞIRLIK İKİLİSİ): Brüt ve Net ağırlıklar virgülden sonra 3 hane barındıran ÇİFTLERDİR.
            const weightRegex = /^\d+[.,]\d{3}$/;
            let hasWeights = false; // <-- Ağırlık olup olmadığını takip ediyoruz
            if (numTokens.length >= 2) {
                const last = numTokens[numTokens.length - 1];
                const secLast = numTokens[numTokens.length - 2];
                if (weightRegex.test(last) && weightRegex.test(secLast)) {
                    numTokens.pop(); // Net Ağırlığı at
                    numTokens.pop(); // Brüt Ağırlığı at
                    hasWeights = true; // <-- Ağırlık bulduk, koli sayısı da vardır
                }
            }

            // MİKTAR (QUANTITY) BULMA: Kalan en son eleman KESİNLİKLE Quantity'dir.
            let quantity = "";
            if (numTokens.length > 0) {
                let rawQty = numTokens.pop(); // Örn: "1,050" veya "63"
                quantity = rawQty.replace(/[.,]/g, ''); // Sayıyı saf hale getirir
            }

            // TEMİZLİK 4 (KOLİ SAYISI DÜZELTMESİ)
            // Eğer ağırlık varsa, Quantity'den önce Koli Adedi (örn: "1") kalmıştır, onu da çöpe at.
            if (hasWeights && numTokens.length > 0) {
                numTokens.pop();
            }

            // Geriye kalan sayıları Description'ın sonuna iade et
            const description = parts.slice(0, j + 1).concat(numTokens).join(" ");

            // Sadece geçerli bir miktar (Quantity) bulunduysa listeye ekle
            if (quantity) {
                products.push({
                    pallet_number: currentPalletNo,
                    item_number: itemNumber,
                    description: description,
                    quantity: quantity
                });
            }
        }
    }

    let lastValidPallet = null;
    for (let p of products) {
        if (p.pallet_number) lastValidPallet = p.pallet_number;
        else if (lastValidPallet) p.pallet_number = lastValidPallet;
    }

    return products;
}

exports.convertPackingList = async (req, res) => {
    let tempPdfPath = null;
    let tempTxtPath = null;

    try {
        if (!req.file) {
            return res.status(400).json({ error: "Lütfen bir dosya yükleyin" });
        }

        console.log("🚀 Hermes PDF İşlemi Başlıyor...");
        const originalName = req.file.originalname;

        console.log(`1. ${originalName} BunnyCDN'e yükleniyor...`);
        const inputCdnUrl = await storageService.uploadToCDN(
            req.file.buffer,
            originalName
        );
        console.log("-> PDF Linki:", inputCdnUrl);

        console.log("2. PDF analiz için yerel diske hazırlanıyor...");
        const tempFileName = `hermes_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        tempPdfPath = path.join(os.tmpdir(), `${tempFileName}.pdf`);
        tempTxtPath = path.join(os.tmpdir(), `${tempFileName}.txt`);

        await fs.writeFile(tempPdfPath, req.file.buffer);

        console.log("3. pdftotext ile PDF verileri metne dönüştürülüyor...");
        await execPromise(`pdftotext -layout "${tempPdfPath}" "${tempTxtPath}"`);

        console.log("4. Metin verileri analiz ediliyor...");
        const pdfText = await fs.readFile(tempTxtPath, 'utf8');
        const parsedJsonData = parseHermesPackingList(pdfText);

        console.log("5. JSON verisi Excel (XLSX) formatına dönüştürülüyor...");

        const formattedDataForExcel = parsedJsonData.map(item => ({
            "Pallet Number": item.pallet_number,
            "Item Number": item.item_number,
            "Description": item.description,
            "Quantity": item.quantity
        }));

        const worksheet = xlsx.utils.json_to_sheet(formattedDataForExcel, {
            header: ["Pallet Number", "Item Number", "Description", "Quantity"]
        });

        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, "Paket_Listesi");

        const excelBuffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        const outputFileName = `${path.parse(originalName).name}_analyzed.xlsx`;
        console.log(`6. Sonuç dosyası (${outputFileName}) BunnyCDN'e yükleniyor...`);

        const outputCdnUrl = await storageService.uploadToCDN(
            excelBuffer,
            outputFileName
        );
        console.log("-> İşlem Tamam! XLSX Linki:", outputCdnUrl);

        res.status(200).json({
            success: true,
            message: "Hermes PDF dönüştürme başarılı",
            input_url: inputCdnUrl,
            xlsx_url: outputCdnUrl,
            file_name: outputFileName,
            data: parsedJsonData
        });

    } catch (error) {
        console.error("❌ Controller Hatası:", error.message);
        const errorMessage = error.response?.data?.message || error.message;

        res.status(500).json({
            success: false,
            error: "İşlem sırasında bir hata oluştu: " + errorMessage
        });
    } finally {
        if (tempPdfPath) await fs.unlink(tempPdfPath).catch(() => { });
        if (tempTxtPath) await fs.unlink(tempTxtPath).catch(() => { });
    }
};