import { IsDateString, IsNumber, IsOptional, IsString, Min } from 'class-validator';

// Manual invoice entry (BRD section 14), extended with `ocr*` fields for the
// Tesseract.js receipt-scan pre-fill (OcrService). BRD section 21 - Invoice
// Data Integrity: ocr* is write-once (set only here, at creation); UpdateInvoiceDto
// intentionally does NOT extend the ocr* fields so a later edit can only ever
// touch final_* plus modifiedBy/modifiedAt.
class InvoiceFinalFieldsDto {
  @IsOptional()
  @IsString()
  invoiceNumber?: string;

  @IsOptional()
  @IsDateString()
  invoiceDate?: string;

  @IsOptional()
  @IsString()
  merchantId?: string;

  @IsOptional()
  @IsString()
  finalMerchantName?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  finalSubtotal?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  finalTax?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  finalServiceCharge?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  finalDiscount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  finalTotal?: number;
}

export class CreateInvoiceDto extends InvoiceFinalFieldsDto {
  @IsOptional()
  @IsString()
  ocrMerchantName?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  ocrSubtotal?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  ocrTax?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  ocrServiceCharge?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  ocrDiscount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  ocrTotal?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  ocrConfidence?: number;
}

export class UpdateInvoiceDto extends InvoiceFinalFieldsDto {}
