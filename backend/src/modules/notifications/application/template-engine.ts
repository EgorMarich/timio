export class TemplateEngine {
  render(
    template: string,
    variables: Record<string, unknown>
  ) {
    return template.replace(
      /\{\{(.*?)\}\}/g,
      (_, key) => String(variables[key.trim()] ?? "")
    );
  }
}