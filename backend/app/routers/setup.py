from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from app.routers._deps import provider_service
from app.services.desktop_setup import service

router=APIRouter(prefix='/api/setup',tags=['setup'])
class InstallBody(BaseModel):
    dependencies: bool=False
@router.get('')
async def status(providers=Depends(provider_service)):
    return await service.tools(providers)
@router.get('/installations')
async def installations():
    return await service.installations()
@router.post('/{tool}/install')
async def install(tool:str,request:Request,body:InstallBody|None=None):
    if getattr(request.app.state.cli_tools,'installation_active',False):raise HTTPException(409,'Another CLI upgrade is running')
    return service.install(tool,dependencies=bool(body and body.dependencies))
@router.post('/{tool}/cancel')
async def cancel(tool:str):
    return service.cancel(tool)
