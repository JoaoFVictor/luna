import { studioApi } from "@/api/client"
import "@/index.css"

// Calling the async bootstrap consumes and removes #capability synchronously,
// before the React application and its dependency graph are imported.
const bootstrap = studioApi.bootstrap()
// Mark an early network rejection as observed while the UI chunk is loading;
// mountStudio still receives the original promise and renders the real error.
void bootstrap.catch(() => undefined)

void import("@/main")
  .then(({ mountStudio }) => mountStudio(bootstrap))
  .catch(() => {
    const container = document.getElementById("root")
    if (container !== null) {
      container.textContent =
        "O Luna Studio não conseguiu carregar a interface. Reinicie o servidor local e tente novamente."
    }
  })
