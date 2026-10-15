import { productMonogram } from "@/lib/product-monogram";

type Props = {
  name: string;
  size?: number;
  className?: string;
  testId?: string;
  alt?: string;
};

export function BrandMonogram({ name, size = 32, className, testId, alt = "" }: Props) {
  return (
    <span
      className={`brand-monogram${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      data-testid={testId}
    >
      {productMonogram(name)}
    </span>
  );
}
