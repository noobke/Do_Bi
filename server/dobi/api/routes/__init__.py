"""路由聚合。全部挂在 `/api` 下。"""

from fastapi import APIRouter

from . import chapters, ops, projects, truth

api_router = APIRouter(prefix="/api")
api_router.include_router(projects.router)
api_router.include_router(chapters.router)
api_router.include_router(truth.router)
api_router.include_router(ops.router)

__all__ = ["api_router"]
