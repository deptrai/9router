ALTER TABLE "ledger_transactions" ADD COLUMN "currency" varchar(10) DEFAULT 'VND' NOT NULL;--> statement-breakpoint
CREATE INDEX "ledger_wallet_id_idx" ON "ledger_transactions" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "ledger_reference_id_idx" ON "ledger_transactions" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "ledger_created_at_idx" ON "ledger_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "product_inventory_product_id_idx" ON "product_inventory" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_inventory_prod_status_idx" ON "product_inventory" USING btree ("product_id","status");--> statement-breakpoint
CREATE INDEX "products_supplier_source_id_idx" ON "products" USING btree ("supplier_source_id");--> statement-breakpoint
CREATE INDEX "products_active_category_idx" ON "products" USING btree ("is_active","category");--> statement-breakpoint
ALTER TABLE "product_inventory" ADD CONSTRAINT "product_inventory_status_valid" CHECK ("product_inventory"."status" IN ('AVAILABLE', 'RESERVED', 'SOLD', 'DEFECTIVE'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_price_non_negative" CHECK ("products"."price" >= 0);--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD CONSTRAINT "supplier_markup_non_negative" CHECK ("supplier_sources"."markup_percentage" >= 0);