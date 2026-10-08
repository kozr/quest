import brandIcon from "@/assets/hearwhispers-icon-charcoal.png";

export function BrandIcon({className = ""}) {
  return <img src={brandIcon} alt="" aria-hidden="true" width={32} height={32} className={`brand-icon ${className}`} />;
}
