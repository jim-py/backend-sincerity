// Model metadata may include long templates/licenses. Generated output remains
// tightly bounded; increasing metadata capacity must not increase chat output.
export function ollamaResponseLimit(path) {
  return path === '/api/show' ? 1024 * 1024 : 64 * 1024;
}
