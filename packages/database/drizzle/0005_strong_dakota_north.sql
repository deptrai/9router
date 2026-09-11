CREATE TABLE "product_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"credential_data" text NOT NULL,
	"status" varchar(20) DEFAULT 'AVAILABLE' NOT NULL,
	"order_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sold_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(100),
	"price" numeric(15, 2) NOT NULL,
	"image_url" varchar(512),
	"is_active" boolean DEFAULT true NOT NULL,
	"sourcing_mode" varchar(20) DEFAULT 'IN_HOUSE' NOT NULL,
	"supplier_source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "supplier_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(50) DEFAULT 'WEB_SCRAPER' NOT NULL,
	"target_url" varchar(512),
	"config_credentials" jsonb,
	"markup_percentage" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_inventory" ADD CONSTRAINT "product_inventory_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_source_id_supplier_sources_id_fk" FOREIGN KEY ("supplier_source_id") REFERENCES "public"."supplier_sources"("id") ON DELETE set null ON UPDATE no action;