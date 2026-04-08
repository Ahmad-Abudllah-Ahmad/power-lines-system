/**
 * Format detection labels for display
 * Replaces common variations and formats text properly
 */
export function formatDetectionLabel(label: string | undefined | null): string {
  if (!label) return "Unknown";
  
  // Normalize the label
  let formatted = label.trim();
  const normalized = formatted.toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "conductor" || normalized === "foundation_pedestal") {
    return "Foundation Padesteal";
  }
  
  // Replace underscores with spaces and capitalize words
  formatted = formatted.replace(/_/g, " ");
  formatted = formatted.replace(/-/g, " ");
  
  // Capitalize first letter of each word
  formatted = formatted
    .split(" ")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
  
  return formatted;
}
