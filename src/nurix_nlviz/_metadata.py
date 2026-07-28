from pathlib import Path

app_name = "nurix-nlviz"
app_entrypoint = "nurix_nlviz.backend.app:app"
app_slug = "nurix_nlviz"
api_prefix = "/api"
dist_dir = Path(__file__).parent / "__dist__"