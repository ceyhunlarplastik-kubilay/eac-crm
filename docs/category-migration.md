# Kategori geçişinin son aşaması ve CRUD

Bu sürüm yalnızca `Customer.categoryId` ilişkisini kullanır. Prisma'daki `category`
alanı artık `Category?` ilişkisidir; fiziksel metin sütunu
`20261005010000_contract_customer_categories` migration'ıyla kaldırılır.
Müşteri oluşturma/düzenleme API'leri ve formlar yalnızca `categoryId` kabul eder.
API yanıtındaki `category: string | null`, ilişkiden üretilen gösterim adıdır;
veritabanında tekrar metin olarak tutulmaz.

Önceki expand/backfill aşaması [arşivlenmiş rehberde](category-migration-expand.md)
yer alır. Bu sürümde `migrate deploy` contract migration'ını da içerir: ilk aşamanın
deploy komutunu mevcut veriler üzerinde doğrudan tekrar kullanmayın.

## Ön koşullar ve sıra

Önce Neon **kubi**, sonra production **main** branch'inde uygulayın. SST stage
veritabanı branch'ini seçmez. Her seferinde `.env` içindeki `DATABASE_URL` ve
`DIRECT_URL` aynı hedef Neon branch'ine ait olmalı; `packages/frontend/.env` varsa
onun farklı bir branch'e yönlendirmediğini doğrulayın.

1. Expand migration ve backfill tamamlanmış olmalı. Geçerli kategori eşleşmeleri,
   tarihçe ve Excel import davranışı kubi'de doğrulanmalı.
2. Geri yüklenebilir Neon/PostgreSQL yedeği alın. Snapshot tam veritabanı yedeği değildir.
3. Yazmaları gerçekten durdurun. Production'da bu yeni ilişki sürümünü
   `CUSTOMER_WRITES_PAUSED=true` ile deploy edin; bütün eski instance'ların
   devreden çıkmasını ve devam eden firma/Excel isteklerinin bitmesini bekleyin.
   Kubi'de dev sürecini durdurun; aynı branch'e başka yerden yazılmadığından emin olun.
4. Bütün yazmalar durduktan sonra yeni **contract snapshot** alın. Eski
   `kubi-before.json` / `production-before.json` backfill snapshot'ları kullanılmaz.
5. Migration'ı uygulayın. Production uygulaması bu noktada eski sütunu artık
   okumuyor/yazmıyor olmalı. Kubi'de uygulama kapalıyken migration uygulanabilir.
6. Snapshot ile doğrulama geçtikten sonra yazmaları açın ve CRUD/Excel smoke testi yapın.

`CATEGORY_READ_SOURCE` kaldırıldı; `.env` içindeki eski değer etkisizdir.
`CUSTOMER_WRITES_PAUSED` halen aktiftir. CLI'daki `--writes-paused` tek başına
uygulamayı durdurmaz, operatörün yazmaları durdurduğunu belirtir.

## Kubi terminal komutları

Repo kökünde, `.env` Neon kubi'ye bağlıyken:

```sh
export CATEGORY_ENDPOINT="ep-jolly-brook-b2c4tf80.c-6.eu-central-1.aws.neon.tech"
mkdir -p .local/category-migration
npm run db:categories -- verify --stage kubi --expected-endpoint "$CATEGORY_ENDPOINT"
npm run db:categories -- snapshot --contract --stage kubi --expected-endpoint "$CATEGORY_ENDPOINT" --output ../../.local/category-migration/kubi-contract-before.json
npm run db:migrate:deploy -- --stage kubi --expected-endpoint "$CATEGORY_ENDPOINT" --writes-paused --snapshot ../../.local/category-migration/kubi-contract-before.json
npm run db:generate
npm run db:categories -- verify --stage kubi --expected-endpoint "$CATEGORY_ENDPOINT" --snapshot ../../.local/category-migration/kubi-contract-before.json
CUSTOMER_WRITES_PAUSED=false npx sst dev --stage kubi
```

Hostname'ler oturumda verilen endpoint'lerdir; Neon konsolunda aynı branch'lere ait
olduklarını doğrulayın. `.env` bağlantılarını komutlar değiştirmez. Snapshot yolları
frontend workspace'e göredir; `.local/` git'e dahil edilmez ve snapshot dosyaları
mevcut dosyanın üstüne yazılmaz. Yeni deneme için yeni dosya adı kullanın.

## Production terminal komutları

Kubi testleri geçtikten ve production yazmaları gerçekten kapatıldıktan sonra
`.env` Neon production/main'e bağlanır:

```sh
export CATEGORY_ENDPOINT="ep-summer-leaf-b2c0ajdt.c-6.eu-central-1.aws.neon.tech"
mkdir -p .local/category-migration
CUSTOMER_WRITES_PAUSED=true npm run deploy -- --stage production
```

Deploy sonrası eski instance'ların devreden çıkmasını ve devam eden isteklerin
bitmesini bekleyin. Yeni uygulamanın yazma API'leri 503 dönmeli; okuma smoke
kontrolü yapın. Uygulama halen eski fiziksel sütun dururken çalışır. Ardından:

```sh
npm run db:categories -- verify --stage production --expected-endpoint "$CATEGORY_ENDPOINT"
npm run db:categories -- snapshot --contract --stage production --expected-endpoint "$CATEGORY_ENDPOINT" --output ../../.local/category-migration/production-contract-before.json
npm run db:migrate:deploy -- --stage production --expected-endpoint "$CATEGORY_ENDPOINT" --writes-paused --snapshot ../../.local/category-migration/production-contract-before.json
npm run db:generate
npm run db:categories -- verify --stage production --expected-endpoint "$CATEGORY_ENDPOINT" --snapshot ../../.local/category-migration/production-contract-before.json
```

Başarılı doğrulama sonrasında yazmaları yeniden açın:

```sh
CUSTOMER_WRITES_PAUSED=false npm run deploy -- --stage production
```

`db:status` pending migration varken exit code 1 dönebilir; bu migration uygulanması
gerektiğini belirtir. Bir taşıma/doğrulama hatasında sonraki adıma geçmeyin.

## Veri koruma ve doğrulama

Contract snapshot, müşteri ID'lerini, kategori ID'lerini, birebir kategori adlarını,
diğer müşteri alanlarının hash'ini ve görüşme/faaliyet geçmişinin hash'ini içerir.
Fiziksel metin sütununun kaldırılması hash karşılaştırmasını bozmaz. Snapshot'tan
sonra herhangi bir iş verisi değiştirilirse doğrulama başarısız olur; bu yüzden
smoke testte yazma işlemlerini ancak son doğrulamadan sonra yapın.

Migration transaction içinde tabloları kilitler ve eski metin ile Category.name
eşleşmesini yeniden kontrol eder. Eşlenmemiş/farklı değer varsa `DROP COLUMN`
çalışmaz. `unmapped`, `invalidReferences` ve `mismatched` sıfır olmalı; contract
sonrasında `hasLegacyCategory=false` beklenir. Metin artık olmadığı için
contract sonrası ad/ID kaybını kanıtlayan kontrol snapshot karşılaştırmasıdır.

Eski v1 snapshot'lar yalnızca eski sütun mevcutken backfill doğrulamasında
desteklenir. Contract için mutlaka `snapshot --contract` ile yeni v2 alın.
Contract sonrasında backfill çalıştırılması açık hata ile reddedilir.

## Kategori CRUD ve smoke testleri

- Dashboard'daki **Kategoriler** ekranında kategori listeleme, ekleme, yeniden
  adlandırma ve silme yapılır. Tüm API'ler admin oturumu gerektirir.
- `GET/POST /api/categories`; `GET/PATCH/DELETE /api/categories/[id]`.
- Aynı adlı ikinci kategori oluşturma veya başka kategorinin adına rename: 409.
  Mevcut harf/boşluk farkları ayrı kalır; yeni boş kategori adı reddedilir.
- Kullanılan kategori rename edilince ID değişmez; bağlı firmalar yeni adı
  ilişki üzerinden gösterir. Müşteri satırları topluca güncellenmez.
- Silinmiş firmalar dahil herhangi bir firmaya bağlı kategori silinemez (409);
  foreign key, eşzamanlı bir firma bağlama yarışında da silmeyi engeller.
- Müşteri formları dropdown'dan ID seçer; kategorisiz seçim `categoryId: null`
  gönderir. Kategoriyi değiştirmeyen PATCH ilişkiyi korur. Yeni kategori ayrıca
  oluşturulup seçilebilir; firma üzerinde serbest kategori metni saklanmaz.
- Excel'in **Kategori** sütunu isim olarak kalır. Sunucu mevcut adı ID'ye çözer,
  bilinmeyen ad için kategori oluşturur; Customer'a yalnız ID yazar.
- Kategori CRUD işlemleri faaliyet geçmişine ID ve okunabilir adlarla kaydedilir.

Smoke test: kategori ekle → firma ekleme/düzenlemede seç → adı değiştir → filtre,
arama ve raporda yeni adı doğrula → bağlı kategoriyi silmenin reddedildiğini gör →
firmayı kategorisiz yap → kullanım kalmadığında kategoriyi sil. Ayrıca tarihsiz
firma Excel'i, mevcut/yeni kategori import'u ve mevcut firma güncellemesini deneyin.

Otomatik kontroller: `npm run test:categories`, `npm run typecheck`,
`npm run frontend:build`.

## Geri dönüş

Eski sütun silinmeden çift yazma sürümüne dönmek gerekiyorsa yazmaları durdurun ve
`prisma/contract/category-restore-legacy.sql` ile metni ilişkiden yeniden eşleyin;
relation-only sürüm eski metni güncel tutmaz.

Silindikten sonra geri dönüşte eski uygulamayı doğrudan başlatmayın. Restore SQL'i
yeni, incelenmiş **ileri yönlü düzeltme migration'ı** olarak uygulayın; ardından
çift yazma sürümüne dönün. Bu SQL güncel kategori adlarını geri oluşturur; rename
öncesi özgün adlar gerekiyorsa yedek/snapshot ve faaliyet kaydı kullanılır.
Geçmişte uygulanmış migration dosyaları değiştirilmez.
