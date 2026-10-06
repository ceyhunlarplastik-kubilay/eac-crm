# Customer → Category geçişi

> Arşiv: bu belge önceki expand sürümünü anlatır. Güncel kod artık contract
> migration'ını içerir. Güncel komutlar için [son aşama rehberini](category-migration.md)
> kullanın; bu belgedeki eski deploy sırası güncel sürümle çalıştırılmaz.

Bu sürüm **expand + çift yazma + backfill + ilişkiye geçiş** aşamalarını içerir.
Eski `Customer.category` sütunu ve indeksi korunur. Silme migration'ı normal
migration zincirinde değildir; `prisma/contract/` altındaki dosyalar son aşama için
incelenecek şablonlardır. Bu sürümü deploy etmek eski sütunu silmez.

## Bağlantı ve çalışma modları

- Önce Neon **kubi** branch'ini kullanın. Neon konsolunda branch'in endpoint'ini
  doğrulayın; endpoint adından branch adı çıkarılamaz.
- Root `.env` içindeki `DATABASE_URL` pooled, `DIRECT_URL` direct bağlantı aynı
  branch/veritabanını göstermeli. `packages/frontend/.env` varsa Prisma onu
  öncelikli kullanır; SST ise root ortamından `DATABASE_URL` alır. İki env dosyasında
  farklı branch bağlantısı bırakmayın. Bağlantıları veya parolaları loglamayın.
- `CATEGORY_READ_SOURCE=legacy`: metni okur, kategori değişikliğinde her iki alanı
  aynı transaction içinde yazar. İlk deploy için varsayılan budur.
- `CATEGORY_READ_SOURCE=relation`: `categoryRef.name` okur, çift yazma devam eder.
  Backfill doğrulanmadan bu modu açmayın; eşlenmemiş kayıtlar kategorisiz görünür.
- `CUSTOMER_WRITES_PAUSED=true`: firma, kategori, görüşme ve Excel yazma API'leri
  503 döndürür; listeleme ve raporlar devam eder. SST bu iki değişkeni frontend'e
  aktarır. Değişiklik sonrası dev sürecini yeniden başlatın/production'ı deploy edin;
  tüm eski instance'ların devreden çıktığını doğrulayın.

CLI her çağrıda açık `--stage kubi|production` ve `--expected-endpoint HOST` ister.
Bu parametreler branch değiştirmez; yanlış bağlantıyı reddeder. `--writes-paused`
bir operatör beyanıdır; tek başına uygulamayı durdurmaz. Devam eden Excel chunk'ları
ve diğer yazmalar bitmeden snapshot/backfill başlatmayın.

## Kubi denemesi

Komutları repo kökünden çalıştırın. `<KUBI_DIRECT_HOST>` yerine Neon'da doğrulanan
tam direct hostname'i kullanın; parola veya URL yazmayın.

1. `CATEGORY_READ_SOURCE=legacy` ayarlayın. Neon geri yükleme noktası veya tam
   `pg_dump` yedeği oluşturun ve geri yüklenebilirliğini doğrulayın. Yedeği `.local/`
   altında ve erişim kısıtlı tutun. Aşağıdaki JSON snapshot **tam yedek değildir**.
2. Yazmaları durdurun, devam eden yüklemeleri bitirin ve SST dev sürecini kapatın.
   Bu branch'i kullanan başka uygulama/manuel yazma olmadığını kontrol edin.
3. Başlangıç envanterini ve bütünlük snapshot'ını alın:

   ```sh
   mkdir -p .local/category-migration
   npm run db:categories -- inspect --stage kubi --expected-endpoint <KUBI_DIRECT_HOST>
   npm run db:categories -- snapshot --stage kubi --expected-endpoint <KUBI_DIRECT_HOST> --output ../../.local/category-migration/kubi-before.json
   ```

4. `npm run db:status` ile daha önce uygulanmış migration'ları kontrol edin.
   Son eklemeli migration dışındaki beklenmeyen pending/failed migration'ları
   çözmeden devam etmeyin. Ardından:

   ```sh
   npm run db:migrate:deploy -- --stage kubi --expected-endpoint <KUBI_DIRECT_HOST>
   npm run db:generate
   npm run db:categories -- backfill --stage kubi --expected-endpoint <KUBI_DIRECT_HOST>
   npm run db:categories -- backfill --stage kubi --expected-endpoint <KUBI_DIRECT_HOST> --apply --writes-paused --snapshot ../../.local/category-migration/kubi-before.json
   npm run db:categories -- verify --stage kubi --expected-endpoint <KUBI_DIRECT_HOST> --snapshot ../../.local/category-migration/kubi-before.json
   ```

   CLI yolları frontend workspace dizinine göredir. Dosyalar `wx` ile oluşturulur;
   mevcut snapshot yanlışlıkla üzerine yazılmaz. Tekrar denemede aynı snapshot'ı
   kullanın; arada müşteri/faaliyet değişmişse önce farkın nedenini çözün.

5. `CATEGORY_READ_SOURCE=relation`, `CUSTOMER_WRITES_PAUSED=false` ayarlayıp
   `npx sst dev --stage kubi` çalıştırın. SST v4 ile dev sunucusunun ürettiği yerel
   URL'de mevcut admin oturumuyla test edin:
   - Firma kategorisi seçme, yenisini oluşturma, temizleme; kategori dışı bir alanı
     değiştirirken kategori/görüşme sayısının korunması.
   - Tarihsiz firma Excel'i; aynı firma/kategori tekrar import; yeni kategori;
     büyük/küçük harf ve boşluk farklarının ayrı kalması.
   - Kategori ID filtresi, eski ad filtresi, metin araması, istatistik ve Excel raporu.
   - İki eşzamanlı aynı adlı kategori isteğinin aynı ID dönmesi.
   - Pause modunda yazmaların 503, okumaların 200 dönmesi.
6. Test yazmaları başladıktan sonra eski snapshot ile tam eşitlik beklenmez.
   Yeni veri üzerinde yalnızca `verify` çalıştırın; `unmapped`, `invalidReferences`
   ve `mismatched` sıfır olmalı. Deneme branch'ini production'a merge etmeyin;
   production verisi kendi snapshot'ından ayrı taşınır.

Yerel otomatik kontroller:

```sh
npm run test:categories
npm run typecheck
npm run frontend:build
```

## Production sırası

Kubi kabul kontrolleri geçmeden production'a uygulamayın. Production için ayrı
bağlantı, doğrulanmış endpoint, tam yedek ve snapshot kullanın. Geliştirmede
`migrate dev` ile hazırlanmış SQL migration'ını canlıda `migrate deploy` uygulayın;
`db:push`, reset veya dev migration komutunu kullanmayın.

Sıra: yedek → expand migration → bu sürümü **legacy** okuma ile deploy → tüm eski
instance'ları devreden çıkar → yazmaları durdur ve uçuş halindeki istekleri bitir →
production snapshot → dry-run/backfill → snapshot ile verify → **relation** okuma
ile deploy → okuma smoke testi → yazmaları aç. CLI örneklerinde `--stage production`
ve production endpoint/snapshot yolunu kullanın.

Müşteri sayısı, ID'ler, özgün metinler, tüm diğer müşteri alanlarının hash'i ve
görüşme/faaliyet geçmişinin hash'i korunmalıdır. Boş metin/boşluk gibi mevcut
değerler birebir taşınır; `null` kategorisiz kalır. Backfill `updatedAt` veya audit
kaydı üretmez. Batch hata alırsa o batch rollback olur; tamamlanmış batch'ler kalır.
Sorunu giderip aynı snapshot ile yeniden çalıştırın.

En az **7 gün** ve en az **bir başarılı Excel import döngüsü** boyunca çift yazmayı
koruyun. Bu sürede `verify` sonuçlarını ve uygulama 400/503/500 hata oranlarını
izleyin. Herhangi bir uyumsuzlukta contract'a geçmeyin.

## Contract: ayrı sonraki release

Bu bölüm gözlem dönemi bittikten sonra uygulanır. **Bu repo sürümü eski sütun
silindikten sonra çalıştırılamaz**, çünkü Prisma halen sütunu seçer/yazar.

1. Yazmaları durdurun; son `verify`, güncel tam yedek ve snapshot alın.
2. Contract uygulama sürümünü ayrı hazırlayın: Prisma'da eski `category String?`
   ve `@@index([category])` kaldırılır; `categoryRef` ilişkisi `category` adını alır.
   Servis çözümleyicisi yalnız `categoryId` yazar; eski metin API girişi isimden
   ID'ye çözülmeye devam eder. Prisma include/select/filter'ları yeni ilişki adını
   kullanır; serializer ilişkiyi dışarı çıkarırken `category: string | null`
   gösterim sözleşmesini korur. Legacy okuma modu kaldırılır. Audit diff kategori
   adlarını karşılaştırır. Form/Excel/API sözleşmeleri değişmez.
3. Contract uygulaması eski fiziksel sütun henüz mevcutken deploy edilir; client
   yeniden üretilir ve okuma kontrolleri yapılır. Yazmalar kapalı kalır.
4. `prisma/contract/category-contract.sql` içeriği yeni migration'a alınır, SQL'i
   incelenir ve `migrate deploy` uygulanır. Template transaction içinde eşleşmeleri
   yeniden kontrol eder; uyuşmazlıkta sütunu silmez. Sonra yazmalar açılır.

## Geri dönüş

- Contract öncesinde eski sütun güncel tutulur. İlişki okumasını `legacy` yapıp
  bu çift yazma sürümüne dönün; Category tablosunu/ID'leri silmeyin.
- Contract uygulaması devreye alındı ama sütun henüz silinmediyse: yazmaları
  durdurun, `category-restore-legacy.sql` şablonuyla ilişkiden metni tazeleyin,
  çift yazma sürümüne dönün ve doğruladıktan sonra yazmaları açın.
- Sütun silindikten sonra: yazmalar kapalıyken restore şablonunu **yeni ileri yönlü
  düzeltme migration'ı** olarak uygulayın, sonra çift yazma sürümüne dönün.
  Kategori adları değiştirilmeye/silinmeye izin verilmediği için metinler ilişkiden
  geri oluşturulur. Geçmiş migration'ları değiştirmeyin veya başarısız migration'ı
  veri durumunu incelemeden uygulanmış işaretlemeyin.
