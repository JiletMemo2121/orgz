require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    EmbedBuilder 
} = require('discord.js');
const { GoogleGenAI } = require('@google/genai');

// Yapay Zeka ve Discord İstemcilerini Başlat
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// Verileri geçici hafızada tutar (İsterseniz JSON dosyasına kaydedebilirsiniz)
let genelTablo = {};

// PUBG Mobile Resmi E-Spor Sıralama Puanları
const SIRALAMA_PUANLARI = {
    1: 10, 2: 6, 3: 5, 4: 4, 5: 3, 6: 2, 7: 1, 8: 1
};

// Slash Komutlarını Tanımla
const commands = [
    new SlashCommandBuilder()
        .setName('skor-ekle')
        .setDescription('PUBG Mobile maç sonu ekran görüntüsünü okur ve tabloya işler.')
        .addAttachmentOption(option => 
            option.setName('ekran_goruntusu')
                .setDescription('Maç sonu sıralama ve kill ekran görüntüsü (SS)')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('tablo')
        .setDescription('Güncel genel skor tablosunu gösterir.'),
    new SlashCommandBuilder()
        .setName('sifirla')
        .setDescription('Kayıtlı tüm skor tablosunu sıfırlar.')
].map(command => command.toJSON());

// Komutları Discord'a Kaydet
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
    try {
        console.log('Slash komutları yükleniyor...');
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );
        console.log('Komutlar başarıyla yüklendi!');
    } catch (error) {
        console.error(error);
    }
})();

// Görseli İndirip Base64 Formatına Çeviren Yardımcı Fonksiyon
async function urlToGenerativePart(url, mimeType) {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    return {
        inlineData: {
            data: Buffer.from(buffer).toString("base64"),
            mimeType
        },
    };
}

// Tablo Mesajı Oluşturucu
function tabloEmbedOlustur(baslik, aciklama) {
    // Puanlara göre büyükten küçüğe sırala
    const siraliListe = Object.entries(genelTablo).sort((a, b) => {
        if (b[1].toplamPuan !== a[1].toplamPuan) {
            return b[1].toplamPuan - a[1].toplamPuan;
        }
        return b[1].kill - a[1].kill; // Puan eşitse kill sayısına bak
    });

    let tabloMetni = "```\n";
    tabloMetni += "SIRA | TAKIM / OYUNCU       | KILL | SIRA P. | TOPLAM\n";
    tabloMetni += "------------------------------------------------------\n";

    if (siraliListe.length === 0) {
        tabloMetni += "Henüz kayıtlı maç verisi bulunmuyor.\n";
    } else {
        siraliListe.forEach(([isim, veri], index) => {
            const sira = `#${index + 1}`.padEnd(4);
            const ad = isim.substring(0, 20).padEnd(20);
            const kill = String(veri.kill).padEnd(4);
            const siraP = String(veri.siraPuani).padEnd(7);
            const toplam = String(veri.toplamPuan);
            tabloMetni += `${sira} | ${ad} | ${kill} | ${siraP} | ${toplam}\n`;
        });
    }
    tabloMetni += "```";

    return new EmbedBuilder()
        .setColor('#F2A900') // PUBG Sarısı
        .setTitle(baslik)
        .setDescription(`${aciklama}\n${tabloMetni}`)
        .setFooter({ text: 'PUBG Mobile Otomatik Skor Sistemi' })
        .setTimestamp();
}

// Komut Dinleyicisi
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // 1. /skor-ekle KOMUTU
    if (interaction.commandName === 'skor-ekle') {
        await interaction.deferReply(); // Yapay zeka analizi birkaç saniye süreceği için beklet

        const attachment = interaction.options.getAttachment('ekran_goruntusu');

        if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
            return interaction.editReply('❌ Lütfen geçerli bir resim dosyası (PNG, JPG, WEBP) yükleyin.');
        }

        try {
            const imagePart = await urlToGenerativePart(attachment.url, attachment.contentType);

            const prompt = `
            Bu bir PUBG Mobile maç sonu sonuç ekranı görüntüsüdür. 
            Görüntüdeki tüm takımları (veya solo ise oyuncuları), maç sıralamalarını (rank) ve toplam öldürme (kill/eleme) sayılarını çıkar.
            Eğer takım üyelerinin kill sayıları ayrı ayrı yazıyorsa onları toplayarak o takımın toplam kill sayısını bul.
            Takım adı yoksa takım liderinin/ilk oyuncunun adını kullan.
            
            SADECE aşağıdaki JSON formatında yanıt ver, başka hiçbir açıklama veya markdown etiketi ekleme:
            [
              {"takim": "Takım veya Oyuncu Adı", "sira": 1, "kill": 12}
            ]
            `;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [prompt, imagePart],
            });

            // Gelen cevabı temizle ve JSON'a çevir
            let rawText = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
            const macSonuclari = JSON.parse(rawText);

            // Puanları hesapla ve genel tabloya ekle
            macSonuclari.forEach(sonuc => {
                const takimAdi = sonuc.takim.trim();
                const kazanilanSiraPuani = SIRALAMA_PUANLARI[sonuc.sira] || 0;
                const kazanilanKill = Number(sonuc.kill) || 0;
                const macToplam = kazanilanSiraPuani + kazanilanKill;

                if (!genelTablo[takimAdi]) {
                    genelTablo[takimAdi] = { kill: 0, siraPuani: 0, toplamPuan: 0 };
                }

                genelTablo[takimAdi].kill += kazanilanKill;
                genelTablo[takimAdi].siraPuani += kazanilanSiraPuani;
                genelTablo[takimAdi].toplamPuan += macToplam;
            });

            const embed = tabloEmbedOlustur(
                '🏆 Güncel PUBG Mobile Skor Tablosu',
                '✅ Maç ekran görüntüsü başarıyla okundu ve puanlar eklendi!'
            );

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('Analiz Hatası:', error);
            await interaction.editReply('❌ Görsel analiz edilirken bir hata oluştu. Lütfen yazıların net okunduğu bir ekran görüntüsü yükleyin.');
        }
    }

    // 2. /tablo KOMUTU
    if (interaction.commandName === 'tablo') {
        const embed = tabloEmbedOlustur(
            '📊 Genel Skor Tablosu',
            'Oynanan tüm maçların toplam puan durumu:'
        );
        await interaction.reply({ embeds: [embed] });
    }

    // 3. /sifirla KOMUTU
    if (interaction.commandName === 'sifirla') {
        genelTablo = {};
        await interaction.reply('🗑️ Skor tablosu başarıyla sıfırlandı. Yeni turnuva/maç serisine başlayabilirsiniz.');
    }
});

client.once('ready', () => {
    console.log(`${client.user.tag} aktif ve maç sonuçlarını bekliyor!`);
});

client.login(process.env.DISCORD_TOKEN);