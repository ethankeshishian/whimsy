# Any copyright is dedicated to the Public Domain.
# W13-R1: the socket an editor saves over; answers each message with "ok".
from mod_pywebsocket import msgutil


def web_socket_do_extra_handshake(request):
    pass


def web_socket_transfer_data(request):
    while not request.client_terminated:
        msg = msgutil.receive_message(request)
        if msg is None:
            return
        msgutil.send_message(request, "ok")
