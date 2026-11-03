/** Web Speech keeps all final results for this recognition session and replaces only interim results. */
export function browserResults(
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>,
  delivered: number,
) {
  const finals: string[] = [];
  let partial = "";
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.isFinal) {
      if (i >= delivered) finals.push(result[0].transcript);
      delivered = Math.max(delivered, i + 1);
    } else partial += result[0].transcript;
  }
  return { finals, partial: partial.trim(), delivered };
}
