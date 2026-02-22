// Base64 image formatting utility.

export function formatBase64(data: string, mediaType: string): string {
  if (data.includes('base64')) {
    data = data.split('base64').pop() as string;
    if (data.startsWith(',')) {
      data = data.slice(1);
    }
  }
  return `data:${mediaType};base64,${data}`;
}
