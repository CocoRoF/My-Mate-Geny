from fastapi import APIRouter, Depends, Request
from app.routers._deps import provider_service
from app.services.desktop_setup import DesktopSetup

router = APIRouter(prefix='/api/setup', tags=['setup'])
service = DesktopSetup()

@router.get('')
async def status(providers=Depends(provider_service)):
    return await service.tools(providers)

@router.post('/{tool}/install')
async def install(tool: str):
    return service.install(tool)

@router.post('/{tool}/cancel')
async def cancel(tool: str):
    return service.cancel(tool)
