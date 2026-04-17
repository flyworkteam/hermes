const express = require('express');
const cors = require('cors');
const apiRoutes = require('./routes/api');
require('dotenv').config();
const path = require('path');

const app = express();
const PORT = 3017;

// --- 1. GÜÇLENDİRİLMİŞ CORS AYARLARI ---
// Tarayıcının "Access-Control-Allow-Origin" hatasını engeller.
app.use(cors({
    origin: '*', // Tüm domainlere izin ver (Test ve Production için en rahatı)
    methods: ['GET', 'POST', 'OPTIONS'], // İzin verilen metodlar
    allowedHeaders: ['Content-Type', 'Authorization'], // İzin verilen başlıklar
    optionsSuccessStatus: 200 // Bazı eski tarayıcılar için 204 yerine 200 dön
}));

// Body Parser Limitlerini Artır (Büyük dosya gönderimi için önlem)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Rotaları bağla
app.use('/api', apiRoutes);

// Sunucuyu Başlat ve Instance'ı bir değişkene ata
const server = app.listen(PORT, () => {
    console.log(`🚀 Sunucu ${PORT} portunda çalışıyor...`);
    console.log(`📡 Endpoint: http://localhost:${PORT}/api/convert`);
    console.log(`⏱️  Zaman aşımı süresi 5 dakikaya ayarlandı.`);
});

// --- 2. ZAMAN AŞIMI (TIMEOUT) AYARLARI ---
// Varsayılan Node.js timeout süresini 5 dakikaya (300.000 ms) çıkarıyoruz.
// Bu sayede n8n işlemi uzun sürse bile Node.js bağlantıyı kesmez.

server.timeout = 600000;
server.keepAliveTimeout = 600000;
server.headersTimeout = 605000; // keepAliveTimeout'tan biraz fazla olmalı

