"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ManagedCategory = { id: string; name: string; customerCount: number };

export function CategoryManager({ open, onOpenChange, categories, onCreate, onRename, onDelete }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: ManagedCategory[];
  onCreate: (name: string) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<boolean>;
  onDelete: (category: ManagedCategory) => Promise<boolean>;
}) {
  const [newName, setNewName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setNewName("");
      setDrafts({});
    }
  }, [open]);

  async function run(key: string, action: () => Promise<boolean>) {
    setPending(key);
    try {
      return await action();
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Kategoriler</DialogTitle>
          <DialogDescription>
            Kategori ekleyin veya adını değiştirin. Silinmiş firmalar dahil herhangi bir firmaya bağlı kategori silinemez.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-2" onSubmit={async (event) => {
          event.preventDefault();
          if (pending || !newName.trim()) return;
          if (await run("create", () => onCreate(newName))) setNewName("");
        }}>
          <Label htmlFor="new-category-name">Yeni kategori</Label>
          <div className="flex gap-2">
            <Input id="new-category-name" value={newName} maxLength={1000}
              placeholder="Kategori adı" disabled={pending !== null}
              onChange={(event) => setNewName(event.target.value)} />
            <Button type="submit" disabled={pending !== null || !newName.trim()}>
              {pending === "create" ? <Loader2 className="animate-spin" /> : <Plus />} Ekle
            </Button>
          </div>
        </form>
        <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
          {categories.map((category) => {
            const draft = drafts[category.id] ?? category.name;
            return (
              <div key={category.id} className="rounded-lg border p-3">
                <Label htmlFor={`category-${category.id}`}>
                  {category.customerCount.toLocaleString("tr-TR")} firma
                </Label>
                <div className="mt-2 flex items-center gap-2">
                  <Input id={`category-${category.id}`} aria-label={`${category.name || "Boş kategori"} kategori adı`}
                    value={draft} maxLength={1000} disabled={pending !== null}
                    onChange={(event) => setDrafts((current) => ({ ...current, [category.id]: event.target.value }))} />
                  <Button type="button" variant="outline" size="icon" aria-label={`${category.name} kategorisini kaydet`}
                    disabled={pending !== null || !draft.trim() || draft === category.name}
                    onClick={async () => {
                      if (await run(category.id, () => onRename(category.id, draft))) {
                        setDrafts((current) => { const next = { ...current }; delete next[category.id]; return next; });
                      }
                    }}>
                    {pending === category.id ? <Loader2 className="animate-spin" /> : <Save />}
                  </Button>
                  <Button type="button" variant="destructive" size="icon" aria-label={`${category.name} kategorisini sil`}
                    title={category.customerCount ? "Firmaya bağlı kategori silinemez" : "Kategoriyi sil"}
                    disabled={pending !== null || category.customerCount > 0}
                    onClick={() => void run(category.id, () => onDelete(category))}>
                    <Trash2 />
                  </Button>
                </div>
              </div>
            );
          })}
          {!categories.length && <p className="py-6 text-center text-sm text-muted-foreground">Henüz kategori yok.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
