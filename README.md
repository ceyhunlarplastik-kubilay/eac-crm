# EAPARAT CRM

Excel ile tutulan müşteri takip listesini Next.js, Cognito ve Neon PostgreSQL üzerinde çalışan basit bir CRM ekranına taşır.

## Stack

- SST `4.17.1`
- Next.js `16`
- React `19`
- Cognito User Pool
- Neon PostgreSQL
- Prisma ORM `7`
- Auth.js / NextAuth Credentials provider
- shadcn/ui tarzı component yapısı, Tailwind CSS, Motion, Recharts, Zod

Custom domain, VPC, router ve mail altyapısı yoktur.

## Kurulum

1. Root `.env` dosyasını oluşturun.

   ```bash
   cp .env.example .env
   ```

2. `.env` içindeki değerleri doldurun.

   ```bash
   DATABASE_URL="postgresql://..."
   DIRECT_URL="postgresql://..."
   AUTH_SECRET="openssl-rand-base64-32"
   ```

   `DIRECT_URL` opsiyoneldir ama Neon kullanırken migration için direct connection URL koymak daha sağlıklıdır. Runtime `DATABASE_URL` kullanır.

3. Bağımlılıkları kurun.

   ```bash
   npm install
   ```

4. Prisma client üretin ve veritabanını hazırlayın.

   ```bash
   npm run db:generate
   npm run db:push
   ```

5. SST dev ortamını root dizinden `kubi` stage ile başlatın.

   ```bash
   export AWS_PROFILE=ceyhunlar-prod
   npx sst dev --stage kubi
   ```

   Local geliştirmede ana komut budur; proje root'undan çalıştırın.

## Cognito

Infra sadece bir Cognito User Pool, bir app client ve `admin` grubu oluşturur. Kullanıcılar admin tarafından Cognito içinde oluşturulur ve CRM'e girecek kullanıcıların `admin` grubuna eklenmesi gerekir.

Giriş akışı Cognito Hosted UI kullanmaz. NextAuth Credentials provider Cognito `USER_PASSWORD_AUTH` ile login olur, token içindeki `cognito:groups` claim'inden `admin` grubunu kontrol eder.

Admin-created kullanıcılar için kalıcı şifre set edin ve kullanıcıyı `admin` grubuna ekleyin. Geçici şifre ile gelen `NEW_PASSWORD_REQUIRED` akışı bu basit başlangıç sürümünde UI içinde ele alınmıyor.

## Excel Import

CRM ekranındaki Excel butonu `.xlsx` dosyasını yükler. Import parser ilk sayfada `Sıra Numarası`, `Firma`, `Web Adresi`, `Email`, `Telefon`, `Şehir`, `Kategori`, `Yetkili`, `Cep Numarası`, `Ulaşıldı`, `Görüşme Sayısı`, `Görüşme Tarihi`, `Görüşme Detayı`, `İlgilenme Durumu`, `Katalog Gönderildi`, `Uygun Ürün Gurubu Var Mı?`, `Cari Bilgisi Geldi`, `Numune Gönderilecek Mi?`, `Gönderim Tarihi` başlıklarını arar.

Kayıtlar firma, şehir, telefon ve email üzerinden oluşturulan `dedupeKey` ile tekrar import edildiğinde güncellenir.

## Komutlar

```bash
export AWS_PROFILE=ceyhunlar-prod
npx sst dev --stage kubi
npm run deploy
npm run frontend:dev
npm run frontend:build
npm run db:generate
npm run db:push
npm run db:status
npm run db:migrate
npm run db:studio
npm run typecheck
```

Kategori modeline veri kaybetmeden geçiş, kubi denemeleri ve production sırası için
[kategori geçiş runbook'u](docs/category-migration.md) kullanılır. Güncel sürüm
yalnızca kategori ilişkisini kullanır; eski metin sütunu doğrulama kontrollü
contract migration'ıyla kaldırılır. Kategoriler dashboard'dan yönetilir.

## Görüşme analizi

Admin panelindeki Görüşme Analizleri sayfası müşteriyle yapılan telefon kaydını
S3'e yükler; EventBridge ve Step Functions ile Transcribe → Google Gemini akışını
çalıştırır. Görüşme özeti, müşteri ihtiyacı, takip adımları ve katalogdan
kaynaklı ürün önerileri müşteriye bağlı `CallRecording` tablosuna kaydedilir.
Katalog ve şirket dokümanları Google `gemini-embedding-001` ile indekslenir;
arama Neon üzerinde pgvector ve tam metin aramasını birleştirir.
Kurulum, PDF indeksleme ve kubi/production komutları için
[görüşme analizi rehberini](docs/post-call-analytics.md) kullanın.

Farklı müşteri görüşmelerini sesli kaydedip sistemi denemek için
[test diyalogları ve beklenen sonuçlar](test-diyaloglari/README.md) proje
kökündeki `test-diyaloglari/` klasöründedir.
