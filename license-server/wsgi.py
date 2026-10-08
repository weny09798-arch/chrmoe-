import os

from licensing import create_app

os.umask(0o077)
app = create_app()
